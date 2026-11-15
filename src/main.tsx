import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Apply the saved appearance before React mounts to avoid a light-mode flash.
try {
  const saved=localStorage.getItem('risexscan-theme');
  if(saved==='light'||saved==='dark')document.documentElement.dataset.theme=saved;
  else document.documentElement.dataset.theme=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
} catch {document.documentElement.dataset.theme='dark';}
createRoot(document.getElementById('root')!).render(<App />);
