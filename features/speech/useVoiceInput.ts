import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useRef, useState } from 'react';

// Push-to-talk voice input: hold to record, release to send the final
// transcript. On-device iOS speech recognition — audio is not uploaded.
export function useVoiceInput(onTranscript: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const transcriptRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useSpeechRecognitionEvent('result', (event) => {
    transcriptRef.current = event.results[0]?.transcript ?? transcriptRef.current;
  });

  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    const text = transcriptRef.current.trim();
    transcriptRef.current = '';
    if (text) onTranscriptRef.current(text);
  });

  useSpeechRecognitionEvent('error', () => {
    setListening(false);
    transcriptRef.current = '';
  });

  const start = useCallback(async () => {
    const permissions = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permissions.granted) return;
    transcriptRef.current = '';
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: false,
    });
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  return { listening, start, stop };
}
