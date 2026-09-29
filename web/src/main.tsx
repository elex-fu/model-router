import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import './style.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5000, refetchOnWindowFocus: true } } });
const pathname = window.location.pathname;
const basename = pathname === '/console' || pathname.startsWith('/console/') ? '/' : '/admin';
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><BrowserRouter basename={basename}><App /></BrowserRouter></QueryClientProvider></React.StrictMode>);
