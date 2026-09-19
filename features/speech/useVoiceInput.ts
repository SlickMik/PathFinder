import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useRef, useState } from 'react';
import { reapplyAudioMode } from './speech';

// Push-to-talk voice input: hold to record, release to send the final
// transcript. On-device iOS speech recognition — audio is not uploaded.
export function useVoiceInput(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const transcriptRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useSpeechRecognitionEvent('start', () => {
    console.log('[voice] recognition started');
    setListening(true);
  });

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    console.log(`[voice] result (final=${event.isFinal}): "${transcript}"`);
    if (transcript) transcriptRef.current = transcript;
  });

  useSpeechRecognitionEvent('end', () => {
    const text = transcriptRef.current.trim();
    console.log(`[voice] recognition ended, transcript: "${text}"`);
    setListening(false);
    transcriptRef.current = '';
    // Recognition switched the audio session to record mode — restore
    // playback mode or replies may go quiet / route to the earpiece.
    void reapplyAudioMode();
    if (text) onTranscriptRef.current(text);
  });

  useSpeechRecognitionEvent('error', (event) => {
    console.warn(`[voice] error: ${event.error} — ${event.message}`);
    setListening(false);
    transcriptRef.current = '';
    void reapplyAudioMode();
  });

  const start = useCallback(async () => {
    try {
      const permissions = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      console.log(
        `[voice] permissions: granted=${permissions.granted} status=${permissions.status}`,
      );
      if (!permissions.granted) {
        console.warn('[voice] permission denied — enable Microphone + Speech Recognition in Settings > PathFinder');
        return;
      }
      transcriptRef.current = '';
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: false,
        requiresOnDeviceRecognition: false,
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
    ExpoSpeechRecognitionModule.stop();
  }, []);

  return { listening, start, stop };
}
