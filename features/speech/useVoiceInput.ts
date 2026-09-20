import { requireOptionalNativeModule, useEventListener } from 'expo';
import type { EventEmitter } from 'expo-modules-core/types';
import { useCallback, useRef, useState } from 'react';
import { reapplyAudioMode } from './speech';

type SpeechRecognitionEvents = {
  start: (event: null) => void;
  audioend: (event: { uri?: string | null }) => void;
  result: (event: {
    isFinal: boolean;
    results: Array<{ transcript: string }>;
  }) => void;
  end: (event: null) => void;
  error: (event: { error: string; message: string }) => void;
};

type SpeechRecognitionModule = EventEmitter<SpeechRecognitionEvents> & {
  requestPermissionsAsync: () => Promise<{ granted: boolean; status: string }>;
  start: (options: {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    requiresOnDeviceRecognition: boolean;
    recordingOptions?: { persist: boolean };
    iosCategory: {
      category: string;
      categoryOptions: string[];
      mode: string;
    };
  }) => void;
  stop: () => void;
};

const nativeSpeechRecognition = requireOptionalNativeModule<SpeechRecognitionModule>(
  'ExpoSpeechRecognition',
);

// Keep the app usable in Expo Go and in an older dev client while the native
// speech module is being added. The real emitter replaces this on a rebuilt
// client; the no-op emitter keeps the hook call order stable otherwise.
const noOpSpeechEmitter = {
  addListener: () => ({ remove() {} }),
} as unknown as EventEmitter<SpeechRecognitionEvents>;
const speechEvents = nativeSpeechRecognition ?? noOpSpeechEmitter;

// Push-to-talk voice input: hold to record, release to send the final
// transcript. When configured, the persisted recording can be sent to the
// app's own companion proxy for more robust transcription.
type VoiceInputOptions = {
  // Called when recognition ends; gotText=false means silence/no speech.
  onEnd?: (gotText: boolean) => void;
};

export function useVoiceInput(
  onTranscript: (text: string, audioUri?: string | null) => void,
  options: VoiceInputOptions = {},
) {
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const transcriptRef = useRef('');
  const audioUriRef = useRef<string | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onEndRef = useRef(options.onEnd);
  onEndRef.current = options.onEnd;

  // The recognizer persists raw audio so Gemini can hear
  // the original speech — more robust than the on-device transcript in noise.
  useEventListener(speechEvents, 'audioend', (event) => {
    audioUriRef.current = event.uri ?? null;
    console.log(`[voice] audio persisted: ${event.uri ? 'yes' : 'no'}`);
  });

  useEventListener(speechEvents, 'start', () => {
    console.log('[voice] recognition started');
    listeningRef.current = true;
    setListening(true);
  });

  useEventListener(speechEvents, 'result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    console.log(`[voice] result (final=${event.isFinal}): "${transcript}"`);
    if (transcript) transcriptRef.current = transcript;
  });

  useEventListener(speechEvents, 'end', () => {
    const text = transcriptRef.current.trim();
    const audioUri = audioUriRef.current;
    console.log(`[voice] recognition ended, transcript: "${text}"`);
    listeningRef.current = false;
    setListening(false);
    transcriptRef.current = '';
    audioUriRef.current = null;
    // Recognition switched the audio session to record mode — restore
    // playback mode or replies may go quiet / route to the earpiece.
    void reapplyAudioMode();
    if (text) onTranscriptRef.current(text, audioUri);
    onEndRef.current?.(Boolean(text));
  });

  useEventListener(speechEvents, 'error', (event) => {
    console.warn(`[voice] error: ${event.error} — ${event.message}`);
    listeningRef.current = false;
    setListening(false);
    transcriptRef.current = '';
    void reapplyAudioMode();
    onEndRef.current?.(false);
  });

  const start = useCallback(async () => {
    if (listeningRef.current) return;
    if (!nativeSpeechRecognition) {
      console.warn('[voice] speech recognition is unavailable in this build');
      return;
    }
    try {
      const permissions = await nativeSpeechRecognition.requestPermissionsAsync();
      console.log(
        `[voice] permissions: granted=${permissions.granted} status=${permissions.status}`,
      );
      if (!permissions.granted) {
        console.warn('[voice] permission denied — enable Microphone + Speech Recognition in Settings > PathFinder');
        return;
      }
      transcriptRef.current = '';
      nativeSpeechRecognition.start({
        lang: 'en-US',
        interimResults: true,
        continuous: false,
        requiresOnDeviceRecognition: false,
        // Keep raw audio so Gemini can transcribe it when available (better
        // in noise/accents); the local transcript remains the fallback.
        recordingOptions: { persist: true },
        iosCategory: {
          category: 'playAndRecord',
          categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
          mode: 'measurement',
        },
      });
      console.log('[voice] start requested');
    } catch (error) {
      console.warn('[voice] start failed:', error);
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => {
    console.log('[voice] stop requested (button released)');
    nativeSpeechRecognition?.stop();
  }, []);

  return { listening, start, stop };
}
