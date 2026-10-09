/**
 * DevTools Bridge Hook
 * 用于与 react-app iframe 中的 devtools-bridge 通信
 */

import { useCallback, useRef, useEffect, useState } from 'react';

interface ConsoleLog {
  type: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

interface NetworkRequest {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  duration?: number;
  requestBody?: string;
  responseBody?: string;
  timestamp: number;
  error?: string;
}

interface RuntimeError {
  message: string;
  source?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  timestamp: number;
}

interface DevToolsBridgeState {
  isReady: boolean;
  consoleLogs: ConsoleLog[];
  networkRequests: NetworkRequest[];
  runtimeErrors: RuntimeError[];
}

export function useDevToolsBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  onRuntimeError?: (error: RuntimeError) => void,
  onUserActivity?: () => void  // 用户在 iframe 中有操作时回调
) {
  const [state, setState] = useState<DevToolsBridgeState>({
    isReady: false,
    consoleLogs: [],
    networkRequests: [],
    runtimeErrors: [],
  });
  
  // 使用 ref 保存最新的 isReady 状态，避免闭包问题
  const isReadyRef = useRef(false);
  
  const pendingRequests = useRef<Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>>(new Map());
  
  // 生成唯一请求 ID
  const generateRequestId = useCallback(() => {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }, []);
  
  // 发送消息到 iframe
  const sendMessage = useCallback((action: string): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) {
        reject(new Error('iframe not available'));
        return;
      }
      
      const requestId = generateRequestId();
      
      // 设置超时
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(requestId);
        reject(new Error('Request timeout'));
      }, 5000);
      
      // 存储 pending request
      pendingRequests.current.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
      
      // 发送消息
      iframe.contentWindow.postMessage({
        type: 'DEVTOOLS_REQUEST',
        action,
        requestId,
      }, '*');
    });
  }, [iframeRef, generateRequestId]);
  
  // 监听来自 iframe 的消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const { type, requestId, result, error } = event.data || {};
      
      if (type === 'DEVTOOLS_READY') {
        // 只在首次 ready 时打印日志
        if (!isReadyRef.current) {
          console.log('🔗 DevTools Bridge: iframe ready');
        }
        isReadyRef.current = true;
        setState(prev => ({ ...prev, isReady: true }));
      } else if (type === 'DEVTOOLS_RESPONSE' && requestId) {
        const pending = pendingRequests.current.get(requestId);
        if (pending) {
          pendingRequests.current.delete(requestId);
          pending.resolve(result);
        }
      } else if (type === 'DEVTOOLS_RUNTIME_ERROR' && error) {
        // 收到运行时错误
        const runtimeError = error as RuntimeError;
        setState(prev => ({
          ...prev,
          runtimeErrors: [...prev.runtimeErrors.slice(-19), runtimeError], // 保留最近 20 条
        }));
        // 回调通知
        onRuntimeError?.(runtimeError);
      } else if (type === 'IFRAME_USER_ACTIVITY') {
        // iframe 中的用户活动
        onUserActivity?.();
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onRuntimeError, onUserActivity]);
  
  // 获取 console 日志
  const getConsoleLogs = useCallback(async (): Promise<ConsoleLog[]> => {
    try {
      const result = await sendMessage('getConsoleLogs');
      const logs = result as ConsoleLog[];
      setState(prev => ({ ...prev, consoleLogs: logs }));
      return logs;
    } catch (error) {
      console.error('Failed to get console logs:', error);
      return [];
    }
  }, [sendMessage]);
  
  // 获取 network 请求
  const getNetworkRequests = useCallback(async (): Promise<NetworkRequest[]> => {
    try {
      const result = await sendMessage('getNetworkRequests');
      const requests = result as NetworkRequest[];
      setState(prev => ({ ...prev, networkRequests: requests }));
      return requests;
    } catch (error) {
      console.error('Failed to get network requests:', error);
      return [];
    }
  }, [sendMessage]);
  
  // 清空日志
  const clearLogs = useCallback(async (): Promise<void> => {
    try {
      await sendMessage('clearLogs');
      setState(prev => ({ ...prev, consoleLogs: [], networkRequests: [], runtimeErrors: [] }));
    } catch (error) {
      console.error('Failed to clear logs:', error);
    }
  }, [sendMessage]);
  
  // 清空运行时错误
  const clearRuntimeErrors = useCallback(() => {
    setState(prev => ({ ...prev, runtimeErrors: [] }));
  }, []);
  
  // 捕获预览区域截图（通过 postMessage 让 iframe 内部截图）
  const captureScreenshot = useCallback(async (fullPage: boolean = false): Promise<string | null> => {
    try {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) {
        console.error('iframe not available for screenshot');
        return null;
      }
      
      const requestId = generateRequestId();
      
      return new Promise((resolve) => {
        // 设置超时
        const timeout = setTimeout(() => {
          pendingRequests.current.delete(requestId);
          console.error('Screenshot request timeout');
          resolve(null);
        }, 30000); // 30秒超时
        
        // 存储 pending request
        pendingRequests.current.set(requestId, {
          resolve: (value) => {
            clearTimeout(timeout);
            const result = value as { screenshot?: string; error?: string };
            if (result?.screenshot) {
              resolve(result.screenshot);
            } else {
              console.error('Screenshot failed:', result?.error);
              resolve(null);
            }
          },
          reject: () => {
            clearTimeout(timeout);
            resolve(null);
          },
        });
        
        // 发送截图请求到 iframe
        iframe.contentWindow!.postMessage({
          type: 'DEVTOOLS_REQUEST',
          action: 'captureScreenshot',
          requestId,
          fullPage,
        }, '*');
      });
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      return null;
    }
  }, [iframeRef, generateRequestId]);
  
  // 刷新 iframe 并清空日志
  const refreshAndClearLogs = useCallback(async (): Promise<void> => {
    try {
      // 先清空日志
      await sendMessage('clearLogs');
      setState(prev => ({ ...prev, consoleLogs: [], networkRequests: [] }));
      
      // 通过 postMessage 让 iframe 自己刷新（避免跨域问题）
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'DEVTOOLS_RELOAD' }, '*');
        // 重置 ready 状态，等待 iframe 重新加载
        isReadyRef.current = false;
        setState(prev => ({ ...prev, isReady: false }));
      }
    } catch (error) {
      console.error('Failed to refresh and clear logs:', error);
    }
  }, [sendMessage, iframeRef]);
  
  // 检查是否准备好（使用 ref 以获取最新值）
  const checkReady = useCallback(() => {
    return isReadyRef.current;
  }, []);

  return {
    isReady: state.isReady,
    isReadyRef, // 暴露 ref 供回调函数使用
    checkReady, // 暴露函数检查最新状态
    consoleLogs: state.consoleLogs,
    networkRequests: state.networkRequests,
    runtimeErrors: state.runtimeErrors,
    getConsoleLogs,
    getNetworkRequests,
    clearLogs,
    clearRuntimeErrors,
    refreshAndClearLogs, // 刷新 iframe 并清空日志
    captureScreenshot, // 捕获预览区域截图
  };
}

export type { ConsoleLog, NetworkRequest, RuntimeError };

