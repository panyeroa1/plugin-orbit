 

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { AppMode, Language, LANGUAGES, RoomState, AudioSource, EmotionType, AUTO_DETECT, EMOTION_COLORS } from './types';
import TranslatorDock from './components/TranslatorDock';
import ErrorBanner from './components/ErrorBanner';
import * as roomStateService from './services/roomStateService';
import * as geminiService from './services/geminiService';

const SUPABASE_URL = 'https://rcbuikbjqgykssiatxpo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjYnVpa2JqcWd5a3NzaWF0eHBvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjQ2NDcyMCwiZXhwIjoyMDgyMDQwNzIwfQ.VVtRWVNMURmi45snFLq733Q_Tzpf1CVXxWPXomxFYGw';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MY_USER_ID = `user_${Math.random().toString(36).substring(7)}`;
const MY_USER_NAME = `Member ${MY_USER_ID.split('_')[1].toUpperCase()}`;
const App: React.FC = () => {
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [mode, setMode] = useState<AppMode>('idle');

  const reportError = useCallback((message: string, error?: any) => {
    console.error(message, error);
    setErrorMessage(message + (error?.message ? `: ${error.message}` : ''));
  }, []);

  // Initialize Auth and Meeting ID
  useEffect(() => {
    const initSession = async () => {
      try {
        // Anonymous Auth
        const { data: { user }, error: authError } = await supabase.auth.signInAnonymously();
        if (authError) {
          reportError("Authentication failed", authError);
        } else {
          setSessionUser(user);
        }

        // Dynamic Meeting ID: Check session storage or URL, else generate new
        let currentMeetingId = sessionStorage.getItem('eburon_meeting_id');
        if (!currentMeetingId) {
          currentMeetingId = `MEETING_${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
          sessionStorage.setItem('eburon_meeting_id', currentMeetingId);
        }
        setMeetingId(currentMeetingId);
      } catch (err) {
        reportError("Session initialization failed", err);
      }
    };

    initSession();
  }, [reportError]);

  const handleExit = async () => {
    await supabase.auth.signOut();
    sessionStorage.removeItem('eburon_meeting_id');
    window.location.reload();
  };

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
  const [fullTranscript, setFullTranscript] = useState('');

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

  // VAD & Segmentation tracking
  const sentenceBufferRef = useRef('');
  const shippedCharsRef = useRef(0);
  const silenceTimerRef = useRef<any>(null);

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

  const splitSentences = (text: string): string[] => {
    if (!text.trim()) return [];
    if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
      const segmenter = new (Intl as any).Segmenter('en', { granularity: 'sentence' });
      return Array.from(segmenter.segment(text)).map((s: any) => s.segment);
    }
    // Fallback: simple split by punctuation
    return text.match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [text];
  };

  const shipSegment = async (text: string, isFinalSegment: boolean = false) => {
    const segment = text.trim();
    if (!segment) return;

    const segmentId = Math.random().toString(36).substring(7);
    try {
      // Fetch latest full transcript to append
      const { data: existing } = await supabase.from('transcript_segments')
        .select('full_transcription')
        .eq('meeting_id', meetingId)
        .maybeSingle();

      const baseText = existing?.full_transcription || '';
      const newFull = isFinalSegment ? (baseText + " " + segment).trim() : baseText;

      const { error } = await supabase.from('transcript_segments').upsert({ 
        meeting_id: meetingId, 
        speaker_id: MY_USER_ID, 
        source_lang: selectedLanguageRef.current.code, 
        source_text: segment,
        full_transcription: newFull,
        last_segment_id: segmentId
      }, { onConflict: 'meeting_id' });
      
      if (error) throw error;
      if (isFinalSegment) setFullTranscript(newFull);
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
    if (!meetingId) return;
    try {
      const { data, error } = await supabase.from('transcript_segments')
        .select('*')
        .eq('meeting_id', meetingId)
        .maybeSingle();
      
      if (error) throw error;
      if (data) handleIncomingRow(data);
    } catch (err) {
      // Silent fail on fetch is okay occasionally, but good to log if persistent
      console.warn("Fetch segment error:", err);
    }
  }, [handleIncomingRow]);

  useEffect(() => {
    if (mode === 'listening' && meetingId) {
      const channel = supabase
        .channel(`meeting:${meetingId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transcript_segments', filter: `meeting_id=eq.${meetingId}` }, 
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
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      setMode('idle');
      setLivePartialText('');
      setLastFinalText('');
      sentenceBufferRef.current = '';
      shippedCharsRef.current = 0;
      roomStateService.releaseSpeaker(MY_USER_ID);
    } else {
      const acquired = roomStateService.tryAcquireSpeaker(MY_USER_ID, MY_USER_NAME);
      if (acquired) {
        try {
           const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
           if (!SpeechRecognition) throw new Error("Speech recognition not supported.");

           const recognition = new SpeechRecognition();
           recognition.continuous = true;
           recognition.interimResults = true;
           recognition.lang = selectedLanguageRef.current.code === 'auto' ? navigator.language : selectedLanguageRef.current.code; 
           
           const flushBuffer = () => {
             const pending = sentenceBufferRef.current.substring(shippedCharsRef.current).trim();
             if (pending) {
               shipSegment(pending, true);
               shippedCharsRef.current = sentenceBufferRef.current.length;
             }
           };

           recognition.onresult = (event: any) => {
             if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
             
             let currentFull = '';
             for (let i = 0; i < event.results.length; ++i) {
               currentFull += event.results[i][0].transcript;
             }
             sentenceBufferRef.current = currentFull;

             // VAD trigger: If we have new sentences, ship them
             const sentences = splitSentences(currentFull);
             if (sentences.length > 1) {
                // All except the last one (which might be incomplete)
                const completeSentences = sentences.slice(0, -1).join(' ');
                const toShip = completeSentences.substring(shippedCharsRef.current).trim();
                if (toShip) {
                  shipSegment(toShip, true);
                  shippedCharsRef.current = completeSentences.length;
                }
             }

             const latestPartial = currentFull.substring(shippedCharsRef.current).trim();
             setLivePartialText(latestPartial);

             // Silence timeout (pseudo-VAD)
             silenceTimerRef.current = setTimeout(flushBuffer, 1500);
           };

           recognition.onerror = (event: any) => {
             if (event.error !== 'no-speech') {
                reportError(`Speech recognition error: ${event.error}`);
                setMode('idle');
             }
           };

           recognition.onend = () => {
             flushBuffer();
           };

           recognition.start();
           recognitionRef.current = recognition;
           setMode('speaking');
           setLastFinalText('');
           sentenceBufferRef.current = '';
           shippedCharsRef.current = 0;
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
    <div className="min-h-screen bg-black flex flex-col items-center overflow-hidden relative pt-[60px]">
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
        onExit={handleExit}
        liveStreamText={sourceDisplayText}
        translatedStreamText={translatedStreamText}
        isTtsLoading={isTtsLoading}
        emotion={emotion}
      />
      
      <ErrorBanner message={errorMessage} onClear={() => setErrorMessage('')} />
      
      {/* Bottom Transcription Area - 14px font, centered, 75px from bottom */}
      <div className="fixed bottom-[75px] left-1/2 -translate-x-1/2 w-full max-w-4xl px-12 z-40 pointer-events-none">
        <div className="text-center">
          {sourceDisplayText && (
            <p className="text-[14px] font-medium tracking-wide text-white/90 drop-shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-300">
              {sourceDisplayText}
            </p>
          )}
          {translatedStreamText && mode === 'listening' && (
            <p className={`text-[14.5px] font-semibold tracking-wide mt-2 drop-shadow-2xl animate-in fade-in slide-in-from-bottom-1 duration-500 ${
              EMOTION_COLORS[emotion] || 'text-emerald-400'
            }`}>
              {translatedStreamText}
            </p>
          )}
        </div>
      </div>

      <div className="fixed inset-0 pointer-events-none -z-10 opacity-30">
        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_50%,rgba(17,24,39,1)_0%,rgba(0,0,0,1)_100%)]" />
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-900/10 blur-[120px] rounded-full" />
      </div>
    </div>
  );
};


export default App;

