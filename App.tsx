
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { AppMode, Language, LANGUAGES, RoomState, AudioSource, EmotionType, AUTO_DETECT } from './types';
import TranslatorDock from './components/TranslatorDock';
import ErrorBanner from './components/ErrorBanner';
import * as roomStateService from './services/roomStateService';
import * as geminiService from './services/geminiService';

const SUPABASE_URL = 'https://rcbuikbjqgykssiatxpo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjYnVpa2JqcWd5a3NzaWF0eHBvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjQ2NDcyMCwiZXhwIjoyMDgyMDQwNzIwfQ.VVtRWVNMURmi45snFLq733Q_Tzpf1CVXxWPXomxFYGw';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MY_USER_ID = `user_${Math.random().toString(36).substring(7)}`;
const MY_USER_NAME = `Member ${MY_USER_ID.split('_')[1].toUpperCase()}`;
const MEETING_ID = 'SUCCESS72355'; 

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('idle');
  const [audioSource, setAudioSource] = useState<AudioSource>('mic');
  const [roomState, setRoomState] = useState<RoomState>(roomStateService.getRoomState());
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(LANGUAGES[0]);
  
  const [lastFinalText, setLastFinalText] = useState<string>('');
  const [livePartialText, setLivePartialText] = useState<string>('');
  const [translatedStreamText, setTranslatedStreamText] = useState<string>('');
  
  const [emotion, setEmotion] = useState<EmotionType>('neutral');
  const [audioData, setAudioData] = useState<Uint8Array>(new Uint8Array(0));
  const [isTtsLoading, setIsTtsLoading] = useState(false);

  const [errorMessage, setErrorMessage] = useState('');

  const reportError = useCallback((message: string, error?: any) => {
    console.error(message, error);
    setErrorMessage(message + (error?.message ? `: ${error.message}` : ''));
  }, []);

  const selectedLanguageRef = useRef<Language>(LANGUAGES[0]);
  useEffect(() => {
    selectedLanguageRef.current = selectedLanguage;
  }, [selectedLanguage]);

  const recognitionRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const isTtsActiveRef = useRef(false);
  const lastProcessedSegmentIdRef = useRef<string | null>(null);
  
  const segmentQueueRef = useRef<any[]>([]);
  const realtimeChannelRef = useRef<any>(null);

  const ensureAudioContext = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(e => reportError("Failed to resume audio context", e));
      }
      return audioCtxRef.current;
    } catch (e) {
      reportError("Failed to initialize audio context", e);
      return null;
    }
  }, [reportError]);

  const shipSegment = async (text: string) => {
    const segment = text.trim();
    if (!segment) return;

    const segmentId = Math.random().toString(36).substring(7);
    try {
      const { error } = await supabase.from('transcript_segments').upsert({ 
        meeting_id: MEETING_ID, 
        speaker_id: MY_USER_ID, 
        source_lang: selectedLanguageRef.current.code, 
        source_text: segment,
        last_segment_id: segmentId
      }, { onConflict: 'meeting_id' });
      
      if (error) throw error;
    } catch (err) {
      reportError("Failed to send transcript", err);
    }
  };

  const processNextInQueue = useCallback(async () => {
    if (segmentQueueRef.current.length === 0 || isTtsActiveRef.current) return;

    const row = segmentQueueRef.current.shift();
    if (!row || row.last_segment_id === lastProcessedSegmentIdRef.current) {
      processNextInQueue();
      return;
    }

    lastProcessedSegmentIdRef.current = row.last_segment_id;
    setIsTtsLoading(true);
    
    const currentTargetLang = selectedLanguageRef.current;
    const targetName = currentTargetLang.code === 'auto' ? 'English' : currentTargetLang.name;
    const ctx = ensureAudioContext();
    
    if (!ctx) {
      setIsTtsLoading(false);
      return;
    }

    try {
      isTtsActiveRef.current = true;
      
      await geminiService.streamTranslation(
        row.source_text,
        targetName,
        ctx,
        (data) => {
          setAudioData(data);
          setIsTtsLoading(false);
        },
        (text) => setTranslatedStreamText(text),
        () => {
          isTtsActiveRef.current = false;
          setAudioData(new Uint8Array(0));
          if (segmentQueueRef.current.length > 0) processNextInQueue();
          else setTimeout(() => { if (!isTtsActiveRef.current) setTranslatedStreamText(''); }, 3000);
        },
        row.source_lang
      );
    } catch (err) {
      reportError("Failed to process translation", err);
      setIsTtsLoading(false);
      isTtsActiveRef.current = false;
      processNextInQueue();
    }
  }, [ensureAudioContext, reportError]);

  const handleIncomingRow = useCallback((row: any) => {
    if (!row || row.speaker_id === MY_USER_ID) return;
    if (row.last_segment_id === lastProcessedSegmentIdRef.current) return;
    if (segmentQueueRef.current.some(q => q.last_segment_id === row.last_segment_id)) return;

    segmentQueueRef.current.push(row);
    processNextInQueue();
  }, [processNextInQueue]);

  const fetchCurrentSegment = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('transcript_segments')
        .select('*')
        .eq('meeting_id', MEETING_ID)
        .maybeSingle();
      
      if (error) throw error;
      if (data) handleIncomingRow(data);
    } catch (err) {
      // Silent fail on fetch is okay occasionally, but good to log if persistent
      console.warn("Fetch segment error:", err);
    }
  }, [handleIncomingRow]);

  useEffect(() => {
    if (mode === 'listening') {
      const channel = supabase
        .channel(`meeting:${MEETING_ID}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transcript_segments', filter: `meeting_id=eq.${MEETING_ID}` }, 
          (payload) => handleIncomingRow(payload.new))
        .subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR') {
             reportError(`Realtime connection error: ${status}`, err);
          }
        });
      
      realtimeChannelRef.current = channel;
      fetchCurrentSegment();
      const pollInterval = setInterval(fetchCurrentSegment, 2000);

      return () => {
        if (realtimeChannelRef.current) supabase.removeChannel(realtimeChannelRef.current);
        clearInterval(pollInterval);
      };
    }
  }, [mode, handleIncomingRow, fetchCurrentSegment, reportError]);

  const toggleListen = async () => {
    const ctx = ensureAudioContext(); 
    if (!ctx) return;
    
    if (mode === 'listening') {
      setMode('idle');
      setTranslatedStreamText('');
      setAudioData(new Uint8Array(0));
      segmentQueueRef.current = [];
      lastProcessedSegmentIdRef.current = null;
    } else {
      setMode('listening');
      setLivePartialText('');
      setLastFinalText('');
      setTranslatedStreamText('');
    }
  };

  const handleSpeakToggle = () => {
    ensureAudioContext();
    if (mode === 'speaking') {
      if (recognitionRef.current) recognitionRef.current.stop();
      setMode('idle');
      setLivePartialText('');
      setLastFinalText('');
      roomStateService.releaseSpeaker(MY_USER_ID);
    } else {
      const acquired = roomStateService.tryAcquireSpeaker(MY_USER_ID, MY_USER_NAME);
      if (acquired) {
        try {
           // Helper to check browser support
           const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
           if (!SpeechRecognition) {
             throw new Error("Speech recognition not supported in this browser.");
           }

           const recognition = new SpeechRecognition();
           recognition.continuous = true;
           recognition.interimResults = true;
           recognition.lang = selectedLanguageRef.current.code === 'auto' ? navigator.language : selectedLanguageRef.current.code; 
           
           recognition.onresult = (event: any) => {
             let final = '', interim = '';
             for (let i = event.resultIndex; i < event.results.length; ++i) {
               if (event.results[i].isFinal) {
                 final = event.results[i][0].transcript;
                 setLastFinalText(final);
                 setLivePartialText('');
                 shipSegment(final);
               } else {
                 interim += event.results[i][0].transcript;
               }
             }
             if (interim) setLivePartialText(interim);
           };

           recognition.onerror = (event: any) => {
             console.error("Speech recognition error", event);
             // Don't show banner for 'no-speech' as it's common
             if (event.error !== 'no-speech') {
                reportError(`Speech recognition error: ${event.error}`);
                setMode('idle');
             }
           };

           recognition.start();
           recognitionRef.current = recognition;
           setMode('speaking');
           setLastFinalText('');
        } catch (e) {
          reportError("Failed to start speech recognition", e);
          setMode('idle');
        }
      } else {
        reportError("Could not acquire speaker lock (someone else is speaking).");
      }
    }
  };

  useEffect(() => {
    const unsub = roomStateService.subscribeToRoomState(setRoomState);
    return () => unsub();
  }, []);

  const sourceDisplayText = livePartialText || lastFinalText;

  return (
    <div className="min-h-screen bg-black flex flex-col items-center pt-48 p-4 overflow-hidden relative">
      <ErrorBanner message={errorMessage} onClear={() => setErrorMessage('')} />
      <TranslatorDock
        mode={mode}
        roomState={roomState}
        selectedLanguage={selectedLanguage}
        myUserId={MY_USER_ID}
        onSpeakToggle={handleSpeakToggle}
        onListenToggle={toggleListen}
        onLanguageChange={setSelectedLanguage}
        onRaiseHand={() => roomStateService.raiseHand(MY_USER_ID, MY_USER_NAME)}
        audioData={audioData}
        audioSource={audioSource}
        onAudioSourceToggle={() => setAudioSource(audioSource === 'mic' ? 'system' : 'mic')}
        liveStreamText={sourceDisplayText}
        translatedStreamText={translatedStreamText}
        isTtsLoading={isTtsLoading}
        emotion={emotion}
      />
      <div className="fixed inset-0 pointer-events-none -z-10 opacity-30">
        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_50%,rgba(17,24,39,1)_0%,rgba(0,0,0,1)_100%)]" />
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-900/10 blur-[120px] rounded-full" />
      </div>
    </div>
  );
};

export default App;
