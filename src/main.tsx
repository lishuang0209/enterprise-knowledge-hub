import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { WorkspaceProvider } from './workspace';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#315ff4', colorText: '#25324b', colorTextSecondary: '#7c879d', colorBorder: '#e3e8f0', borderRadius: 8, fontSize: 14, controlHeight: 38, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' }, components: { Button: { primaryShadow: 'none' }, Table: { headerBg: '#f8f9fc', headerColor: '#7a869d', rowHoverBg: '#f7f9ff' }, Tabs: { itemSelectedColor: '#315ff4' }, Modal: { titleFontSize: 18 } } }}>
      <AntApp><WorkspaceProvider><App /></WorkspaceProvider></AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
