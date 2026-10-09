/**
 * Speech Synthesis Hook - ElevenLabs版本
 * 使用 ElevenLabs TTS API 进行高质量语音朗读
 */

import { useCallback, useRef, useState, useEffect } from 'react';

interface SpeechSettings {
  rate: number;      // 语速（保留接口兼容，ElevenLabs 暂不使用）
  pitch: number;     // 音调（保留接口兼容，ElevenLabs 暂不使用）
  volume: number;    // 音量 0 - 1
  voiceId?: string;  // ElevenLabs 语音 ID
}

interface Voice {
  voice_id: string;
  name: string;
  labels: Record<string, any>;
}

interface UseSpeechSynthesisReturn {
  // 状态
  isEnabled: boolean;
  isSpeaking: boolean;
  isPaused: boolean;
  voices: Voice[];
  currentVoice: Voice | null;
  settings: SpeechSettings;
  
  // 方法
  setEnabled: (enabled: boolean) => void;
  appendText: (text: string) => void;
  flushBuffer: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setVoice: (voiceId: string) => void;
  updateSettings: (settings: Partial<SpeechSettings>) => void;
}

// 句子结束标点（中英文）
const SENTENCE_ENDERS = /([。！？.!?；;])/;

// 默认设置
const DEFAULT_SETTINGS: SpeechSettings = {
  rate: 1.0,
  pitch: 1,
  volume: 1,
};

// 存储 key
const SETTINGS_KEY = 'elevenlabs_speech_settings';
const ENABLED_KEY = 'elevenlabs_speech_enabled';
const VOICE_KEY = 'elevenlabs_voice_id';

// API 地址
// Vite 下没有 process.env：优先用 VITE_ 变量，其次按当前主机名推断（与 lib/api.ts 保持一致，支持局域网访问）
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? `http://${window.location.hostname}:8008` : "http://localhost:8008");

export function useSpeechSynthesis(): UseSpeechSynthesisReturn {
  // 状态
  const [isEnabled, setIsEnabledState] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [currentVoice, setCurrentVoice] = useState<Voice | null>(null);
  const [settings, setSettings] = useState<SpeechSettings>(DEFAULT_SETTINGS);
  
  // Refs
  const textBufferRef = useRef<string>('');
  const sentenceQueueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioQueueRef = useRef<Blob[]>([]);
  const isEnabledRef = useRef(false);
  const settingsRef = useRef(settings);
  const currentVoiceRef = useRef(currentVoice);
  const isPausedRef = useRef(false);
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // 同步 ref 值
  useEffect(() => {
    isEnabledRef.current = isEnabled;
  }, [isEnabled]);
  
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  
  useEffect(() => {
    currentVoiceRef.current = currentVoice;
  }, [currentVoice]);
  
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);
  
  // 初始化
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    console.log('🎙️ ElevenLabs TTS 已初始化');
    
    // 创建 Audio 元素
    const audio = new Audio();
    audioRef.current = audio;
    
    audio.onended = () => {
      console.log('✅ 音频播放完成');
      isProcessingRef.current = false;
      // 播放下一个
      processAudioQueue();
    };
    
    audio.onerror = (e) => {
      console.error('❌ 音频播放错误:', e);
      isProcessingRef.current = false;
      // 尝试播放下一个
      processAudioQueue();
    };
    
    // 加载保存的设置
    try {
      const savedSettings = localStorage.getItem(SETTINGS_KEY);
      if (savedSettings) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) });
      }
      
      const savedEnabled = localStorage.getItem(ENABLED_KEY);
      if (savedEnabled === 'true') {
        setIsEnabledState(true);
        isEnabledRef.current = true;
        console.log('🔊 从 localStorage 恢复语音开启状态');
      }
    } catch (e) {
      console.error('Failed to load speech settings:', e);
    }
    
    // 获取可用的语音列表
    loadVoices();
    
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
    };
  }, []);
  
  // 加载语音列表
  const loadVoices = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/tts/voices`);
      const data = await response.json();
      const availableVoices = data.voices || [];
      
      console.log(`🎤 可用语音数量: ${availableVoices.length}`);
      if (availableVoices.length > 0) {
        console.log('🎤 可用语音列表 (前5个):', availableVoices.slice(0, 5).map((v: Voice) => v.name));
      }
      
      setVoices(availableVoices);
      
      // 恢复保存的语音或选择默认语音
      const savedVoiceId = localStorage.getItem(VOICE_KEY);
      if (savedVoiceId) {
        const savedVoice = availableVoices.find((v: Voice) => v.voice_id === savedVoiceId);
        if (savedVoice) {
          setCurrentVoice(savedVoice);
          currentVoiceRef.current = savedVoice;
          console.log('🎤 恢复保存的语音:', savedVoice.name);
          return;
        }
      }
      
      // 默认选择第一个语音
      if (availableVoices.length > 0) {
        setCurrentVoice(availableVoices[0]);
        currentVoiceRef.current = availableVoices[0];
        console.log('🎤 选择默认语音:', availableVoices[0].name);
      }
    } catch (e) {
      console.error('❌ 获取语音列表失败:', e);
    }
  };
  
  // 生成语音（调用后端 API）
  const generateSpeech = async (text: string): Promise<Blob | null> => {
    try {
      const voice = currentVoiceRef.current;
      const response = await fetch(`${API_BASE_URL}/api/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice_id: voice?.voice_id,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`TTS API error: ${response.status}`);
      }
      
      return await response.blob();
    } catch (e) {
      console.error('❌ 生成语音失败:', e);
      return null;
    }
  };
  
  // 处理音频队列
  const processAudioQueue = useCallback(async () => {
    if (!isEnabledRef.current || isProcessingRef.current || isPausedRef.current) return;
    
    // 先处理已生成的音频
    if (audioQueueRef.current.length > 0) {
      const audioBlob = audioQueueRef.current.shift();
      if (audioBlob && audioRef.current) {
        isProcessingRef.current = true;
        setIsSpeaking(true);
        
        const audioUrl = URL.createObjectURL(audioBlob);
        audioRef.current.src = audioUrl;
        audioRef.current.volume = settingsRef.current.volume;
        
        try {
          await audioRef.current.play();
          console.log('🔊 开始播放音频');
        } catch (e) {
          console.error('❌ 播放失败:', e);
          isProcessingRef.current = false;
          URL.revokeObjectURL(audioUrl);
          // 尝试播放下一个
          processAudioQueue();
        }
        
        return;
      }
    }
    
    // 再处理文本队列
    const nextSentence = sentenceQueueRef.current.shift();
    if (!nextSentence) {
      setIsSpeaking(false);
      return;
    }
    
    console.log('🎤 生成语音:', nextSentence.substring(0, 30) + (nextSentence.length > 30 ? '...' : ''));
    
    const audioBlob = await generateSpeech(nextSentence);
    if (audioBlob) {
      audioQueueRef.current.push(audioBlob);
      processAudioQueue();
    } else {
      // 生成失败，继续处理下一个
      processAudioQueue();
    }
  }, []);
  
  // 追加流式文本
  const appendText = useCallback((text: string) => {
    if (!isEnabledRef.current || !text) return;
    
    // 简单累积文本，不做任何切分
    textBufferRef.current += text;
    
    // 清除之前的定时器
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
    
    // 设置新的定时器：800ms 没有新文本就朗读
    flushTimerRef.current = setTimeout(() => {
      const content = textBufferRef.current.trim();
      if (content) {
        console.log('🎤 Auto flush:', content.substring(0, 50) + '...');
        sentenceQueueRef.current.push(content);
        textBufferRef.current = '';
        
        if (!isProcessingRef.current) {
          processAudioQueue();
        }
      }
    }, 800);
  }, [processAudioQueue]);
  
  // 刷新缓冲区
  const flushBuffer = useCallback(() => {
    if (!isEnabledRef.current) return;
    
    // 清除定时器
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    
    const remaining = textBufferRef.current.trim();
    if (remaining) {
      console.log('🎤 Flushing buffer:', remaining.substring(0, 50) + '...');
      sentenceQueueRef.current.push(remaining);
      textBufferRef.current = '';
      
      if (!isProcessingRef.current) {
        processAudioQueue();
      }
    }
  }, [processAudioQueue]);
  
  // 开关语音朗读
  const setEnabled = useCallback((enabled: boolean) => {
    console.log(`🔊 setEnabled called with: ${enabled}`);
    
    setIsEnabledState(enabled);
    isEnabledRef.current = enabled;
    localStorage.setItem(ENABLED_KEY, String(enabled));
    
    if (enabled) {
      console.log('🔊 ElevenLabs TTS enabled');
      // 播放测试音（可选）
      // 由于 ElevenLabs 需要网络请求，可以跳过测试音
    } else {
      stop();
      console.log('🔇 ElevenLabs TTS disabled');
    }
  }, []);
  
  // 暂停
  const pause = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPaused(true);
      console.log('⏸️ 暂停播放');
    }
  }, []);
  
  // 继续
  const resume = useCallback(() => {
    if (audioRef.current && isPausedRef.current) {
      audioRef.current.play().catch(e => console.error('恢复播放失败:', e));
      setIsPaused(false);
      console.log('▶️ 继续播放');
    }
    
    // 如果队列中有待处理的，继续处理
    if (!isProcessingRef.current) {
      processAudioQueue();
    }
  }, [processAudioQueue]);
  
  // 停止并清空
  const stop = useCallback(() => {
    // 清除定时器
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    
    textBufferRef.current = '';
    sentenceQueueRef.current = [];
    audioQueueRef.current = [];
    isProcessingRef.current = false;
    setIsSpeaking(false);
    setIsPaused(false);
    console.log('⏹️ 停止播放');
  }, []);
  
  // 设置语音
  const setVoice = useCallback((voiceId: string) => {
    const voice = voices.find(v => v.voice_id === voiceId);
    if (voice) {
      setCurrentVoice(voice);
      currentVoiceRef.current = voice;
      localStorage.setItem(VOICE_KEY, voiceId);
      console.log('🎤 切换语音:', voice.name);
    }
  }, [voices]);
  
  // 更新设置
  const updateSettings = useCallback((newSettings: Partial<SpeechSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);
  
  return {
    isEnabled,
    isSpeaking,
    isPaused,
    voices,
    currentVoice,
    settings,
    setEnabled,
    appendText,
    flushBuffer,
    pause,
    resume,
    stop,
    setVoice,
    updateSettings,
  };
}
