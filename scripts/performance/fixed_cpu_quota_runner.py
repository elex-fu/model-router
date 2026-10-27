#!/usr/bin/env python3
"""Opt-in, finite, portable app-only Docker quota ABBA diagnostic.

Default is a pure plan. Execution needs explicit authorization and the exact SHA
whose native correctness CI is green. This runner never pushes or dispatches CI.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid

from fixed_cpu_quota_contract import CGROUP_FILES, cohort_plan, parse_cgroup_snapshot, resource_delta, summarize_attempts, validate_workload_result

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = "scripts/performance/fixed-cpu/fixture.cjs"
IMAGES = {"postgres": "postgres:16.8-bookworm", "redis": "redis:7.4.2-bookworm"}
BASE_IMAGES = {"node": "node:22.16.0-bookworm", "go": "golang:1.24.4-bookworm"}
TOKEN = "RUN_FIXED_CPU_DIAGNOSTIC"
MAX_SECONDS = 110 * 60
OWNER_LABEL = "io.model-router.quota.run"
MAX_LOG_BYTES = 2 * 1024 * 1024
# Fixed ports live ONLY inside a new --network=none namespace per arm.
# Nothing is published; host services and unrelated containers are unreachable.
PORTS = {"pgPort": 55432, "redisPort": 56379, "mockPort": 58443, "appPort": 58080}


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def safe_log(value):
    value = value.decode('utf8', errors='replace') if isinstance(value, bytes) else str(value or '')
    value = re.sub(r'(https?://)[^/\s:@]+:[^/\s@]+@', r'\1[REDACTED]@', value)
    value = re.sub(r'(?i)(token|password|secret|api[_-]?key)([=:]\s*)[^\s]+', r'\1\2[REDACTED]', value)
    return {'text': value[:MAX_LOG_BYTES], 'truncated': len(value) > MAX_LOG_BYTES, 'originalCharacters': len(value)}


def copy_required_json(source, target):
    if not source.is_file():
        raise ValueError('QUOTA_REQUIRED_EVIDENCE_MISSING:' + source.name)
    # Preserve original bytes even when JSON is malformed, then fail qualification.
    shutil.copyfile(source, target)
    value = json.loads(target.read_text())
    if not isinstance(value, dict):
        raise ValueError('QUOTA_INVALID_EVIDENCE:' + source.name)
    return value


def retain_driver_files(fixture, out, filename):
    for suffix, retained_suffix in [('.json', '-raw.json'), ('.json.attempts.jsonl', '-attempts.jsonl')]:
        source = fixture / (filename + suffix)
        if source.is_file():
            shutil.copyfile(source, out / (filename + retained_suffix))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def comparison_report(plan, results):
    """Descriptive ABBA comparison, never a statistical/performance pass."""
    by_label = {result['label']: result for result in results}
    groups = {}
    for entry in plan:
        key = entry['profile'] + '-' + entry['protocol']
        group = groups.setdefault(key, {'profile': entry['profile'], 'protocol': entry['protocol'], 'arms': []})
        group['arms'].append({'position': entry['position'], 'arm': entry['arm'], 'label': entry['label'],
                              'outcome': by_label.get(entry['label'])})
    for group in groups.values():
        arms = group['arms']
        group['completeABBA'] = len(arms) == 4 and all(row['outcome'] is not None for row in arms)
        group['validDiagnostic'] = group['completeABBA'] and all(row['outcome']['validDiagnostic'] for row in arms)
        group['descriptiveRatiosOfArmMeans'] = None
        if group['validDiagnostic']:
            def mean(arm, metric):
                values = [row['outcome']['metrics'][metric] for row in arms if row['arm'] == arm]
                return sum(values) / len(values)
            group['descriptiveRatiosOfArmMeans'] = {
                'boundedOverSingleThroughput': mean('bounded', 'successRps') / mean('single', 'successRps'),
                'boundedOverSingleCpuPerSuccess': mean('bounded', 'cpuMillisecondsPerSuccess') / mean('single', 'cpuMillisecondsPerSuccess'),
            }
    complete = len(results) == len(plan) and all(entry['label'] in by_label for entry in plan)
    valid = complete and all(result['validDiagnostic'] for result in results)
    return {'groups': list(groups.values()), 'cohortComplete': complete, 'validDiagnostic': valid,
            'conclusion': 'complete-valid-diagnostic-not-performance-acceptance' if valid else 'inconclusive',
            'plannedArms': len(plan), 'retainedArms': len(results), 'performanceAcceptance': False,
            'interpretation': 'Raw arm tails/errors retained; ratios are descriptive means of two arms, not pooled quantiles, confidence intervals or a performance acceptance test.'}


class Runner:
    def __init__(self, args, plan):
        self.args, self.plan = args, plan
        self.deadline = time.monotonic() + MAX_SECONDS
        self.run_token = uuid.uuid4().hex
        self.prefix = "mr-quota-" + self.run_token[:12]
        self.container_ids = {}
        self.containers = []
        self.image = self.prefix + ":cohort"
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.private = Path(tempfile.mkdtemp(prefix="mr-quota-private-"))
        self.results = []
        self.image_id = None
        self.network_name = None

    def command(self, args, *, timeout=180, stdin=None, check=True):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("QUOTA_COHORT_110_MINUTE_DEADLINE")
        return subprocess.run(args, cwd=ROOT, input=stdin, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=min(timeout, remaining), check=check)

    def docker(self, *args, **kwargs):
        return self.command(["docker", *map(str, args)], **kwargs)

    def owned_container(self, name, *, independent=False):
        # Names may collide or be reused. Mutation always targets a proven exact ID.
        result = (subprocess.run(['docker', 'inspect', name], text=True, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=5, check=False) if independent
                  else self.docker('inspect', name, check=False))
        if result.returncode != 0:
            return None
        raw = json.loads(result.stdout)[0]
        if (raw.get('Config', {}).get('Labels') or {}).get(OWNER_LABEL) != self.run_token:
            return None
        previous = self.container_ids.get(name)
        if previous is not None and previous != raw['Id']:
            return None
        self.container_ids[name] = raw['Id']
        return raw

    @staticmethod
    def public_inspect(raw):
        # Never publish Env, credentials, full mounts or container logs.
        return {"Id": raw["Id"], "Image": raw["Image"], "State": raw["State"], "OwnershipLabel": (raw.get("Config", {}).get("Labels") or {}).get(OWNER_LABEL),
                "HostConfig": {key: raw["HostConfig"].get(key) for key in
                               ["NanoCpus", "CpuQuota", "CpuPeriod", "CpusetCpus", "Memory", "MemorySwap", "PidsLimit", "NetworkMode", "Privileged"]}}

    def inspect(self, name):
        raw = self.owned_container(name)
        if raw is None:
            raise ValueError('QUOTA_CONTAINER_OWNERSHIP_UNPROVEN:' + name)
        return self.public_inspect(raw)

    def remove_owned(self, name):
        raw = self.owned_container(name, independent=True)
        if raw is None:
            return False
        result = subprocess.run(['docker', 'rm', '-f', '-v', raw['Id']], text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        if result.returncode != 0:
            raise RuntimeError('QUOTA_OWNED_CONTAINER_CLEANUP_FAILED:' + raw['Id'])
        self.container_ids.pop(name, None)
        return True

    def launch(self, name, image, command=(), *, fixture=None, app=False, env_file=None, options=(), network=None):
        self.containers.append(name)  # Intended names are inspected; only matching full-token-owned IDs can be removed.
        resource = ["--cpus=2", "--memory=2g", "--memory-swap=2g"] if app or image == IMAGES["postgres"] else ["--cpus=1", "--memory=512m", "--memory-swap=512m"]
        args = ["run", "-d", "--name", name, "--label", OWNER_LABEL + "=" + self.run_token, "--network=" + (network or "container:" + self.network_name), "--pids-limit=256", "--security-opt=no-new-privileges", *resource]
        if image == self.image_id:
            args += ["--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp"]
        if fixture:
            args += ["--mount", f"type=bind,src={fixture},dst=/fixture"]
        if env_file:
            args += ["--env-file", str(env_file)]
        self.docker(*args, *options, image, *command)
        self.inspect(name)
        return self.container_ids[name]

    def one_shot(self, fixture, *command, env=(), timeout=180, output_name=None):
        # Setup/audit/driver are OUTSIDE app quota; each has the same explicit independent bound.
        name = self.prefix + "-helper-" + uuid.uuid4().hex[:8]
        self.containers.append(name)
        result = self.docker("run", "--name", name, "--label", OWNER_LABEL + "=" + self.run_token, "--network=" + ("container:" + self.network_name if self.network_name else "none"), "--cpus=1", "--memory=512m", "--memory-swap=512m", "--pids-limit=256", "--security-opt=no-new-privileges",
                             "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp", "--mount", f"type=bind,src={fixture},dst=/fixture", *env, self.image_id, *command,
                             timeout=timeout, check=False)
        facts = self.inspect(name)
        if output_name:
            save(output_name, facts)
        if not self.remove_owned(name):
            raise ValueError('QUOTA_HELPER_CLEANUP_OWNERSHIP_UNPROVEN:' + name)
        self.containers.remove(name)
        if result.returncode != 0:
            # Fixture errors contain assertion labels only, not environment/key files.
            raise RuntimeError(f"QUOTA_HELPER_FAILED:{command[0]}:exit={result.returncode}: {safe_log(result.stderr)['text'][-1000:]}")
        return result

    def ready(self, predicate, seconds, label):
        deadline = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.2)
        raise TimeoutError(label)

    def http(self, port, route, *, tls=False, certificate=None):
        # Read from our isolated namespace; never send traffic to a host service.
        assert self.network_name and (not tls or certificate is not None)
        script = "const fs=require('fs'),http=require(" + json.dumps('https' if tls else 'http') + ");" + \
            "const req=http.get({hostname:'127.0.0.1',port:" + str(port) + ",path:" + json.dumps(route) + \
            (",ca:fs.readFileSync('/fixture/certificate.pem')" if tls else "") + \
            "},res=>{let data='';res.on('data',chunk=>{data+=chunk;if(data.length>1048576)req.destroy(Error('body bound'))});res.on('end',()=>{if(res.statusCode!==200)process.exit(2);JSON.parse(data);console.log(data)})});req.setTimeout(2000,()=>req.destroy(Error('timeout')));req.on('error',()=>process.exit(3));"
        return json.loads(self.docker('exec', self.network_name, 'node', '-e', script, timeout=5).stdout)

    def service_snapshot(self, name):
        command = 'set -e; for n in cpu.max cpu.stat memory.max memory.current memory.peak memory.events; do printf "###%s\\n" "$n"; cat "/sys/fs/cgroup/$n"; done'
        return {'observedAtUnixNs': str(time.time_ns()), 'raw': self.docker('exec', name, 'sh', '-c', command).stdout}

    def snapshot(self, name):
        # Read-only exec belongs to this same cgroup. Its small cost is NOT subtracted.
        script = "const f=require('fs');const names=" + json.dumps(CGROUP_FILES) + ";console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,f.readFileSync('/sys/fs/cgroup/'+n,'utf8')]))))"
        started = time.time_ns()
        raw = json.loads(self.docker("exec", name, "node", "-e", script).stdout)
        proof = parse_cgroup_snapshot(raw)  # Must succeed BEFORE any warm/timed requests.
        proof.update(observedStartUnixNs=str(started), observedEndUnixNs=str(time.time_ns()))
        return proof

    def build_image(self, archive):
        build_output = {}
        try:
            with archive.open('rb') as source:
                result = subprocess.run(['docker', 'build', '--file', 'scripts/performance/fixed-cpu/Dockerfile', '--tag', self.image, '-'],
                                        cwd=ROOT, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        timeout=min(900, self.deadline - time.monotonic()), check=False)
                build_output = {'exitCode': result.returncode, 'stdout': safe_log(result.stdout), 'stderr': safe_log(result.stderr)}
                if result.returncode != 0:
                    raise RuntimeError('QUOTA_IMAGE_BUILD_FAILED: see build-output.json')
        except subprocess.TimeoutExpired as error:
            build_output = {'timedOut': True, 'stdout': safe_log(error.stdout), 'stderr': safe_log(error.stderr)}
            raise
        finally:
            save(self.output / 'build-output.json', build_output)
            archive.unlink()

    def prepare(self):
        commit = self.command(["git", "rev-parse", "HEAD"]).stdout.strip()
        if not re.fullmatch(r"[a-f0-9]{40}", self.args.native_correctness_sha or "") or commit != self.args.native_correctness_sha:
            raise ValueError("QUOTA_NATIVE_CORRECTNESS_SHA_MUST_MATCH_CHECKOUT")
        self.command(["git", "diff", "--exit-code", "HEAD", "--"])
        if self.command(["git", "status", "--porcelain", "--untracked-files=all"]).stdout.strip():
            raise ValueError("QUOTA_REQUIRES_CLEAN_TRACKED_SOURCE")
        self.docker("info", "--format", "{{json .}}")
        # Resolve once for the cohort. No pull/update is performed between arms.
        for image in {**IMAGES, **BASE_IMAGES}.values():
            self.docker("pull", image, timeout=300)
        # Build context contains only exact committed bytes, never ignored local files.
        archive = self.private / 'source.tar'
        self.command(['git', 'archive', '--format=tar', '--output=' + str(archive), 'HEAD'])
        self.build_image(archive)
        self.image_id = self.docker("image", "inspect", self.image, "--format", "{{.Id}}").stdout.strip()
        provenance = {"sourceCommit": commit, "nativeCorrectnessCommit": self.args.native_correctness_sha,
                      "appImageId": self.image_id, "images": {}, "plan": self.plan, "performanceAcceptance": False,
                      "host": {"platform": os.uname().sysname, "release": os.uname().release, "cpuCount": os.cpu_count()},
                      "limits": {"cohortSeconds": MAX_SECONDS, "c32AdmissionSeconds": 60, "c32CountCap": None, "c200Attempts": 10000, "driverDeadlineSeconds": 120},
                      "resourceBoundary": "app only, including primary and every child/native thread; PG, Redis, TLS mock, driver, setup and audit are separate containers on the same host; no dedicated physical-CPU claim",
                      "cpuInterval": "snapshots enclose external driver launch, request loop, driver report serialization, helper inspect/remove, copying and host summary serialization; not only client loop; no overhead subtraction",
                      "driverResources": "driver getrusage covers its process and all threads during the request loop; peak RSS is process lifetime observed at loop end, excluding later serialization; not a cgroup peak",
                      "postgresStorage": "fresh owned anonymous Docker volume, normal fsync=on and synchronous_commit=on; not tmpfs; removed with owned container",
                      "files": {str(p.relative_to(ROOT)): sha(p) for p in sorted((ROOT / 'scripts/performance/fixed-cpu').glob('*')) if p.is_file()}}
        for kind, image in {**IMAGES, **BASE_IMAGES}.items():
            provenance["images"][kind] = json.loads(self.docker("image", "inspect", image, "--format", "{{json .}}").stdout)
        self.network_name = None
        proof = self.one_shot(self.private, 'sh', '-c', 'node --version; sha256sum /usr/local/bin/quota-client /usr/local/bin/quota-mock /app/dist/cli/index.js')
        provenance['compiledTools'] = proof.stdout
        save(self.output / "manifest.json", provenance)

    def certificate(self, fixture, out):
        # Created at execution, valid well beyond the bounded 2-hour cohort. Real chain+IP verification.
        self.command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(fixture / 'tls-key.pem'), "-out", str(fixture / 'certificate.pem'), "-days", "2", "-subj", "/CN=quota-disposable-local", "-addext", "subjectAltName=IP:127.0.0.1"], timeout=30)
        verified = self.command(["openssl", "verify", "-CAfile", str(fixture / 'certificate.pem'), "-verify_ip", "127.0.0.1", str(fixture / 'certificate.pem')])
        validity = self.command(["openssl", "x509", "-checkend", str(MAX_SECONDS + 600), "-noout", "-in", str(fixture / 'certificate.pem')])
        os.chmod(fixture / 'tls-key.pem', 0o600)
        shutil.copyfile(fixture / 'certificate.pem', out / 'certificate.pem')
        save(out / 'certificate-proof.json', {
            'verifiedAtUnixNs': str(time.time_ns()), 'verifyChainAndIpExit': verified.returncode,
            'verifyChainAndIpOutput': verified.stdout.strip(), 'ip': '127.0.0.1',
            'checkendSeconds': MAX_SECONDS + 600, 'checkendExit': validity.returncode,
            'sha256': sha(fixture / 'certificate.pem'),
            'metadata': self.command(['openssl', 'x509', '-in', str(fixture / 'certificate.pem'), '-noout', '-dates', '-ext', 'subjectAltName']).stdout,
        })

    def queue_checkpoint(self, app, out, stage):
        attempts = []
        deadline = min(self.deadline, time.monotonic() + 10)
        while time.monotonic() < deadline:
            nonce = uuid.uuid4().hex
            try:
                result = self.docker('exec', self.container_ids[app], 'node', 'scripts/performance/fixed-cpu/checkpoint.cjs', 'queue', nonce, timeout=7)
                proof = json.loads(result.stdout)
                if proof.get('nonce') != nonce:
                    raise ValueError('QUOTA_STALE_CHECKPOINT_NONCE')
                attempts.append(proof)
                if proof.get('allQueuesZero') is True:
                    return proof
            finally:
                save(out / (stage + '-queue-checkpoints.json'), {'attempts': attempts})
            time.sleep(.05)
        raise TimeoutError('QUOTA_NATIVE_QUEUES_DID_NOT_DRAIN:' + stage)

    def retain_before_cleanup(self, fixture, out, outcome, names):
        evidence_errors = []
        for filename in ['warm-bootstrap', 'warm-matched', 'measured']:
            try:
                retain_driver_files(fixture, out, filename)
            except OSError as error:
                evidence_errors.append(str(error))
        for source, target in [('owner-seed-proof.json', 'owner-seed-proof.json'), ('warm.json', 'warm-raw.json'), ('warm-bootstrap.json', 'warm-bootstrap-raw.json'),
                               ('warm-matched.json', 'warm-matched-raw.json'), ('measured.json', 'measured-raw.json'),
                               ('warm-audit.json', 'warm-audit.json'), ('drain-audit.json', 'drain-audit.json'),
                               ('stopped-audit.json', 'stopped-audit.json'), ('process-proof.json', 'process-proof.json'),
                               ('closed-state-proof.json', 'closed-state-proof.json'), ('constructor-proofs.json', 'constructor-proofs.json'), ('state/state.json', 'bounded-last-state.json')]:
            try:
                if (fixture / source).is_file():
                    copy_required_json(fixture / source, out / target)
            except (OSError, ValueError) as error:
                evidence_errors.append(str(error))
        # Startup can fail before aggregate proof assembly; retain each already-written
        # observer/checkpoint proof without publishing private env/key/config files.
        for source in fixture.iterdir():
            if source.is_file() and (re.fullmatch(r'(startup|queue)-[0-9]+\.json', source.name) or source.name == 'primary-startup.json'):
                try:
                    copy_required_json(source, out / source.name)
                except (OSError, ValueError) as error:
                    evidence_errors.append(str(error))
        inspections = {}
        for kind, name in names.items():
            try:
                raw = self.owned_container(name, independent=True)
                if raw is not None:
                    inspections[kind] = self.public_inspect(raw)
                    if kind == 'app' and raw['State']['Running']:
                        script = "const f=require('fs'),o={};for(const n of " + json.dumps(CGROUP_FILES) + "){try{o[n]=f.readFileSync('/sys/fs/cgroup/'+n,'utf8')}catch(e){o[n]={error:e.code}}}console.log(JSON.stringify(o))"
                        result = subprocess.run(['docker', 'exec', raw['Id'], 'node', '-e', script], text=True,
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
                        save(out / 'app-cgroup-before-cleanup.json', {'exitCode': result.returncode, 'raw': result.stdout, 'stderr': safe_log(result.stderr)})
                    if kind == 'network' and raw['State']['Running'] and (fixture / 'certificate.pem').is_file():
                        script = "const h=require('https'),f=require('fs');const q=h.get({hostname:'127.0.0.1',port:" + str(PORTS['mockPort']) + ",path:'/metrics',ca:f.readFileSync('/fixture/certificate.pem')},r=>{let s='';r.on('data',x=>s+=x);r.on('end',()=>console.log(s))});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>process.exit(1))"
                        result = subprocess.run(['docker', 'exec', raw['Id'], 'node', '-e', script], text=True,
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
                        save(out / 'mock-before-cleanup.json', {'exitCode': result.returncode, 'raw': result.stdout, 'stderr': safe_log(result.stderr)})
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                evidence_errors.append(kind + ': ' + str(error))
        save(out / 'containers-before-cleanup.json', inspections)
        outcome['evidenceCaptureErrors'] = evidence_errors
        for required in ['owner-seed-proof.json', 'constructor-proofs.json', 'process-proof.json', 'warm-before-quiet-queue-checkpoints.json', 'warm-after-quiet-queue-checkpoints.json', 'final-drain-queue-checkpoints.json', 'quiet-interval.json', 'warm-raw.json', 'warm-bootstrap-raw.json', 'warm-matched-raw.json', 'measured-raw.json', 'warm-audit.json', 'drain-audit.json', 'stopped-audit.json']:
            if not (out / required).is_file():
                outcome['failures'].append('required evidence missing: ' + required)

    def arm(self, entry):
        label = entry["label"]
        out = self.output / label
        out.mkdir()
        fixture = self.private / label
        fixture.mkdir(mode=0o700)
        contract = entry["contract"]
        input_data = {**PORTS, "arm": entry["arm"], "httpInFlight": contract["httpInFlight"], "creditCap": str(contract["creditCapMinorUnits"])}
        save(fixture / "input.json", input_data)
        save(out / "contract.json", {**entry, **input_data})
        names = {kind: f"{self.prefix}-{label}-{kind}" for kind in ["network", "postgres", "redis", "mock", "app"]}
        outcome = {"label": label, "performanceAcceptance": False, "validDiagnostic": False, "failures": []}
        try:
            self.network_name = names['network']
            self.launch(self.network_name, self.image_id, ['sleep', str(MAX_SECONDS)], fixture=fixture, network='none')
            pg = self.launch(names["postgres"], IMAGES["postgres"], ["postgres", "-p", PORTS["pgPort"], "-c", "listen_addresses=127.0.0.1", "-c", "max_connections=32", "-c", "shared_buffers=128MB", "-c", "fsync=on", "-c", "synchronous_commit=on"], options=["-e", "POSTGRES_DB=model_router_quota", "-e", "POSTGRES_HOST_AUTH_METHOD=trust"])
            self.ready(lambda: self.docker("exec", pg, "pg_isready", "-h", "127.0.0.1", "-p", PORTS["pgPort"], "-U", "postgres", "-d", "model_router_quota", check=False).returncode == 0, 60, "QUOTA_POSTGRES_NOT_READY")
            def sql(text):
                return self.docker("exec", "-i", pg, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", PORTS["pgPort"], "-U", "postgres", "-d", "model_router_quota", stdin=text)
            roles = (ROOT / "deploy/managed-saas-postgres-roles.sql").read_text()
            sql(roles)
            self.one_shot(fixture, "node", "dist/cli/index.js", "saas:migrate", env=["-e", f"MODEL_ROUTER_SAAS_DATABASE_URL=postgresql://model_router_saas_migrator@127.0.0.1:{PORTS['pgPort']}/model_router_quota"])
            sql(roles)
            sql("ALTER ROLE model_router_saas_gateway CONNECTION LIMIT 16;")
            self.launch(names["redis"], IMAGES["redis"], ["redis-server", "--bind", "127.0.0.1", "--port", PORTS["redisPort"], "--save", "", "--appendonly", "no", "--maxmemory", "384mb", "--maxmemory-policy", "noeviction"])
            self.ready(lambda: self.docker("exec", names["redis"], "redis-cli", "-p", PORTS["redisPort"], "ping", check=False).stdout.strip() == "PONG", 30, "QUOTA_REDIS_NOT_READY")
            self.certificate(fixture, out)
            self.one_shot(fixture, "node", FIXTURE, "seed")
            self.launch(names["mock"], self.image_id, ["quota-mock", "-addr", f"127.0.0.1:{PORTS['mockPort']}", "-cert", "/fixture/certificate.pem", "-key", "/fixture/tls-key.pem", "-delay", "5ms"], fixture=fixture)
            def mock_ready():
                try:
                    return self.http(PORTS['mockPort'], '/healthz', tls=True, certificate=fixture / 'certificate.pem').get('local_mock') is True
                except (OSError, ValueError, subprocess.CalledProcessError):
                    return False
            self.ready(mock_ready, 30, "QUOTA_TLS_MOCK_NOT_READY")
            command = ["node", "scripts/performance/fixed-cpu/entry.cjs", "start", "--role", "gateway"]
            if entry["arm"] == "bounded":
                command = ["node", "scripts/performance/fixed-cpu/entry.cjs", "saas:bounded-gateway", "start", "--state-directory", "/fixture/state", "--credit-cap-minor-units", input_data["creditCap"], "--http-in-flight", contract["httpInFlight"], "--database-pool-max", "16"]
            self.launch(names["app"], self.image_id, command, fixture=fixture, app=True, env_file=fixture / 'app.env')
            app_inspect = self.inspect(names["app"])
            assert app_inspect["Image"] == self.image_id
            assert app_inspect['HostConfig']['NanoCpus'] == 2_000_000_000
            assert app_inspect['HostConfig']['Memory'] == app_inspect['HostConfig']['MemorySwap'] == 2 * 1024 ** 3
            assert app_inspect['HostConfig']['Privileged'] is False
            save(out / 'app-container.json', app_inspect)
            save(out / 'quota-before-readiness.json', self.snapshot(names["app"]))
            def app_ready():
                if not self.inspect(names["app"])["State"]["Running"]:
                    raise RuntimeError("QUOTA_APP_EXIT_BEFORE_READY")
                try:
                    self.http(PORTS['appPort'], '/readyz')
                    return True
                except (OSError, ValueError, subprocess.CalledProcessError):
                    return False
            self.ready(app_ready, 240, "QUOTA_APP_NOT_READY_WITH_REAL_REDIS_QUARANTINE")
            self.docker('exec', self.container_ids[names['app']], 'node', 'scripts/performance/fixed-cpu/process-proof.cjs')
            membership = copy_required_json(fixture / 'process-proof.json', out / 'process-proof.json')
            parse_cgroup_snapshot(membership['cgroup'])  # Actual ready PIDs before bootstrap/warm work.
            self.docker('exec', self.container_ids[names['app']], 'node', 'scripts/performance/fixed-cpu/checkpoint.cjs', 'startup', uuid.uuid4().hex)
            copy_required_json(fixture / 'constructor-proofs.json', out / 'constructor-proofs.json')
            def client(filename, count, concurrency, seconds, protocol=None):
                protocol = protocol or entry['protocol']
                try:
                    self.one_shot(fixture, 'quota-client', '-url', f"http://127.0.0.1:{PORTS['appPort']}/v1/chat/completions", '-key-file', '/fixture/api-key', '-n', str(count), '-c', str(concurrency), f"-stream={'true' if protocol == 'sse' else 'false'}", '-duration', f'{seconds}s', '-out', f'/fixture/{filename}.json', timeout=140, output_name=out / f'{filename}-driver-container.json')
                finally:
                    retain_driver_files(fixture, out, filename)
                raw = json.loads((fixture / f'{filename}.json').read_text())
                summary = summarize_attempts(raw['samples'])
                assert raw['requests'] == len(raw['samples'])
                assert raw['success'] == summary['successes'], 'client aggregate must match inclusive raw-sample classification'
                save(out / f'{filename}-summary.json', summary)
                return raw, summary
            bootstrap, _ = client('warm-bootstrap', 10, 1, 0, 'json')
            matched, _ = client('warm-matched', 128, 32, 0)
            warm = {'requests': bootstrap['requests'] + matched['requests'],
                    'success': bootstrap['success'] + matched['success'],
                    'samples': bootstrap['samples'] + matched['samples'],
                    'protocol': '10 JSON/c1 +128 matched/c32', 'excludedAttempts': 0}
            save(fixture / 'warm.json', warm)
            copy_required_json(fixture / 'warm.json', out / 'warm-raw.json')
            if warm['requests'] != 138 or warm['success'] != 138:
                raise ValueError('required 10 JSON/c1 +128 matched/c32 warmup incomplete or contains errors')
            try:
                self.one_shot(fixture, 'node', FIXTURE, 'warm', timeout=60)
            finally:
                if (fixture / 'warm-audit.json').exists():
                    shutil.copyfile(fixture / 'warm-audit.json', out / 'warm-audit.json')
            copy_required_json(fixture / 'warm-audit.json', out / 'warm-audit.json')
            self.queue_checkpoint(names['app'], out, 'warm-before-quiet')
            quiet_started = time.monotonic_ns()
            time.sleep(1)
            self.queue_checkpoint(names['app'], out, 'warm-after-quiet')
            save(out / 'quiet-interval.json', {'startMonotonicNs': str(quiet_started), 'endMonotonicNs': str(time.monotonic_ns()), 'minimumMilliseconds': 1000, 'noDriverRequests': True})
            save(out / 'service-containers.json', {kind: self.inspect(name) for kind, name in names.items() if kind != 'app'})
            stats_before = [json.loads(line) for line in self.docker('stats', '--no-stream', '--format', '{{json .}}', *names.values()).stdout.splitlines()]
            outside_before = {kind: self.service_snapshot(name) for kind, name in names.items() if kind != 'app'}
            before = self.snapshot(names['app'])
            save(out / 'resource-before.json', before)
            measured, summary = client('measured', entry['timedRequests'] or 0, contract['concurrency'], entry['timedSeconds'] or 0)
            save(out / 'workload-proof.json', validate_workload_result(entry, measured))
            after = self.snapshot(names['app'])
            save(out / 'resource-after.json', after)
            delta = resource_delta(before, after)
            delta['cpuMillisecondsPerSuccess'] = delta['cpuMilliseconds'] / measured['success'] if measured['success'] else None
            save(out / 'resource-delta.json', delta)
            outcome['metrics'] = {
                'attempts': summary['attempts'], 'successes': summary['successes'],
                'errorsOrRejections': summary['errorsOrRejections'], 'excludedAttempts': 0,
                'clientDurationSeconds': measured['duration_s'], 'successRps': measured['throughput_success_rps'],
                'cpuMillisecondsPerSuccess': delta['cpuMillisecondsPerSuccess'],
                'throttledMilliseconds': delta['throttledMilliseconds'], 'throttledPeriods': delta['throttledPeriods'],
                'memoryPeakLifetimeBytes': delta['memoryPeakLifetimeAfterBytes'],
                'allAttemptLatencyMs': summary['allAttemptLatencyMs'], 'successfulLatencyMs': summary['successfulLatencyMs'],
            }
            if measured['success'] != measured['requests']:
                outcome['failures'].append('timed attempts contain errors; retained without overload exclusions')
            if delta['oomObserved']:
                outcome['failures'].append('OOM observed')
            outside_after = {kind: self.service_snapshot(name) for kind, name in names.items() if kind != 'app'}
            save(out / 'outside-cgroup-resources.json', {'before': outside_before, 'after': outside_after, 'scope': 'separate infrastructure cgroups, enclosing but not identical to app CPU interval; no outside resources added to app quota metric'})
            stats_after = [json.loads(line) for line in self.docker('stats', '--no-stream', '--format', '{{json .}}', *names.values()).stdout.splitlines()]
            save(out / 'outside-and-app-docker-stats.json', {'before': stats_before, 'after': stats_after, 'scope': 'reported separately; docker percent is not the cgroup CPU-delta metric'})
            try:
                self.one_shot(fixture, 'node', FIXTURE, 'drain', timeout=60)
            except Exception as error:
                outcome['failures'].append(str(error))
            copy_required_json(fixture / 'drain-audit.json', out / 'drain-audit.json')
            self.queue_checkpoint(names['app'], out, 'final-drain')
            mock = self.http(PORTS['mockPort'], '/metrics', tls=True, certificate=fixture / 'certificate.pem')
            save(out / 'mock-final.json', mock)
            total = warm['success'] + measured['success']
            expected_json = 10 + (128 + measured['success'] if entry['protocol'] == 'json' else 0)
            expected_sse = 128 + measured['success'] if entry['protocol'] == 'sse' else 0
            if mock['received'] != total or mock['completed'] != total or mock['json'] != expected_json or mock['sse'] != expected_sse or any(mock[key] for key in ['bad_requests', 'unexpected_paths', 'write_errors', 'in_flight']):
                outcome['failures'].append('raw upstream counts differ from successful client requests or mock errors')
            self.docker('stop', '--time=55', self.container_ids[names['app']], timeout=65)
            stopped = self.inspect(names['app'])
            save(out / 'app-exit.json', stopped)
            if stopped['State']['Running'] or stopped['State']['ExitCode'] != 0 or stopped['State']['OOMKilled']:
                outcome['failures'].append('app did not exit cleanly')
            if entry['arm'] == 'bounded':
                try:
                    self.one_shot(fixture, 'node', FIXTURE, 'state-closed', timeout=10)
                except Exception as error:
                    outcome['failures'].append(str(error))
                if (fixture / 'closed-state-proof.json').is_file():
                    copy_required_json(fixture / 'closed-state-proof.json', out / 'closed-state-proof.json')
            try:
                self.one_shot(fixture, 'node', FIXTURE, 'stopped', timeout=60)
            except Exception as error:
                outcome['failures'].append(str(error))
            copy_required_json(fixture / 'stopped-audit.json', out / 'stopped-audit.json')
            outcome['validDiagnostic'] = not outcome['failures']
        except Exception as error:
            outcome['failures'].append(f'{type(error).__name__}: {error}')
        finally:
            try:
                self.retain_before_cleanup(fixture, out, outcome, names)
            except Exception as error:
                outcome['failures'].append('failure evidence capture incomplete: ' + str(error))
            # Forced cleanup never relabels an app failure as a graceful exit.
            for name in reversed(list(self.containers)):
                try:
                    removed = self.remove_owned(name)
                    if not removed:
                        outcome['failures'].append('cleanup ownership absent/unproven; container untouched: ' + name)
                    self.containers.remove(name)
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                    outcome['failures'].append('owned cleanup failed: ' + name + ': ' + str(error))
            outcome['validDiagnostic'] = not outcome['failures']
            save(out / 'outcome.json', outcome)
            self.results.append(outcome)
            save(self.output / 'results.json', {'arms': self.results, 'performanceAcceptance': False})
            save(self.output / 'comparison.json', comparison_report(self.plan, self.results))
        return outcome['validDiagnostic']

    def run(self):
        try:
            self.prepare()
            for entry in self.plan:
                if not self.arm(entry):
                    # No selective rerun: preserve failed cohort and stop to investigate.
                    return 1
            return 0
        except Exception as error:
            save(self.output / 'cohort-failure.json', {'errorType': type(error).__name__, 'message': str(error), 'performanceAcceptance': False})
            return 1
        finally:
            # Re-verify the full ownership token and immutable ID; never host-wide prune/name scans.
            for name in reversed(self.containers):
                try:
                    self.remove_owned(name)
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
                    pass  # The failed arm already records unresolved cleanup; CI VM remains disposable.
            shutil.rmtree(self.private)
            if self.image_id:
                subprocess.run(['docker', 'image', 'rm', self.image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--authorization', choices=[TOKEN])
    parser.add_argument('--native-correctness-sha')
    parser.add_argument('--profiles', choices=['c32', 'c200', 'both'], default='c32')
    parser.add_argument('--protocols', choices=['json', 'sse', 'both'], default='both')
    parser.add_argument('--output', type=Path, default=Path('quota-evidence'))
    args = parser.parse_args(argv)
    plan = cohort_plan(['c32', 'c200'] if args.profiles == 'both' else [args.profiles], ['json', 'sse'] if args.protocols == 'both' else [args.protocols])
    if args.execute and (args.authorization != TOKEN or not args.native_correctness_sha):
        parser.error('execution requires explicit authorization and native-correctness SHA')
    return args, plan


def main():
    args, plan = parse_args()
    if not args.execute:
        print(json.dumps({'execute': False, 'plan': plan, 'performanceAcceptance': False}, indent=2))
        return 0
    return Runner(args, plan).run()


if __name__ == '__main__':
    raise SystemExit(main())
