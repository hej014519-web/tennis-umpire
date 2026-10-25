import './compat';
import {createRoot} from 'react-dom/client';
import './base.css';
import UmpireApp from '../components/umpire/app';

const root = document.getElementById('root');
if (!root) throw new Error('找不到应用入口。');

createRoot(root).render(<UmpireApp />);
