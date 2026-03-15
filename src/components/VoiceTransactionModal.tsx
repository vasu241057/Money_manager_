import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Plus, Square, Trash2, X } from 'lucide-react';
import type { Account } from '../hooks/useAccounts';
import type { Category } from '../hooks/useCategories';
import type { Transaction } from '../hooks/useTransactions';
import {
  VOICE_MAX_DURATION_MS,
  buildVoiceDraftsFromTranscript,
  getCategoryOptionsForType,
  getDefaultAccountName,
  getDefaultCategoryName,
  learnFromFinalizedDrafts,
  transcribeVoiceAudio,
  type VoiceDraftTransaction,
} from '../services/voiceTransactions';
import { Button } from './ui/Button';
import '../styles/voice-transaction-modal.css';

type RecordingState = 'idle' | 'recording' | 'processing' | 'review' | 'error';

interface VoiceTransactionModalProps {
  categories: Category[];
  accounts: Account[];
  onSaveTransactions: (transactions: Omit<Transaction, 'id'>[]) => void;
  onClose: () => void;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function createEmptyDraft(categories: Category[], accounts: Account[]): VoiceDraftTransaction {
  const type: 'expense' | 'income' = 'expense';

  return {
    id: crypto.randomUUID(),
    amount: 0,
    type,
    category: getDefaultCategoryName(type, categories),
    subCategory: '',
    account: getDefaultAccountName(accounts),
    description: '',
    rawText: '',
    confidence: 0.3,
  };
}

export function VoiceTransactionModal({
  categories,
  accounts,
  onSaveTransactions,
  onClose,
}: VoiceTransactionModalProps) {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [drafts, setDrafts] = useState<VoiceDraftTransaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const elapsedTimerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const isClosingRef = useRef(false);

  const progress = Math.min(100, (elapsedMs / VOICE_MAX_DURATION_MS) * 100);
  const remainingMs = Math.max(0, VOICE_MAX_DURATION_MS - elapsedMs);

  const clearTimers = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }

    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const stopActiveStream = useCallback(() => {
    if (!streamRef.current) {
      return;
    }

    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const processAudioBlob = useCallback(
    async (blob: Blob) => {
      if (isClosingRef.current) {
        return;
      }

      setRecordingState('processing');
      setError(null);

      try {
        const nextTranscript = await transcribeVoiceAudio(blob);
        const parsedDrafts = await buildVoiceDraftsFromTranscript(nextTranscript, categories, accounts);

        if (parsedDrafts.length === 0) {
          throw new Error(
            'Could not extract transactions from this recording. Try speaking one transaction per sentence with amount and category.',
          );
        }

        if (isClosingRef.current) {
          return;
        }

        setTranscript(nextTranscript);
        setDrafts(parsedDrafts);
        setRecordingState('review');
      } catch (processingError) {
        if (isClosingRef.current) {
          return;
        }

        const message =
          processingError instanceof Error
            ? processingError.message
            : 'Voice processing failed. Please try again.';
        setError(message);
        setRecordingState('error');
      }
    },
    [accounts, categories],
  );

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      return;
    }

    clearTimers();
    setRecordingState('processing');

    try {
      recorder.stop();
    } catch (stopError) {
      console.error('Failed to stop recorder:', stopError);
      setError('Could not stop recording cleanly. Please try again.');
      setRecordingState('error');
      stopActiveStream();
    }
  }, [clearTimers, stopActiveStream]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access is not supported in this browser.');
      setRecordingState('error');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setError('MediaRecorder is not available in this browser.');
      setRecordingState('error');
      return;
    }

    setError(null);
    setTranscript('');
    setDrafts([]);
    setElapsedMs(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];

      const supportedMimeType = preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      const recorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType })
        : new MediaRecorder(stream);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      isClosingRef.current = false;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error('Recorder error:', event);
        setError('Recording failed. Please try again.');
        setRecordingState('error');
      };

      recorder.onstop = () => {
        clearTimers();
        stopActiveStream();
        recorderRef.current = null;

        if (isClosingRef.current) {
          return;
        }

        const audioBlob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });

        if (audioBlob.size === 0) {
          setError('No audio captured. Please record again.');
          setRecordingState('error');
          return;
        }

        void processAudioBlob(audioBlob);
      };

      const startedAt = Date.now();
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startedAt);
      }, 200);

      stopTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, VOICE_MAX_DURATION_MS);

      recorder.start(1000);
      setRecordingState('recording');
    } catch (startError) {
      console.error('Start recording error:', startError);
      setError('Microphone permission denied or unavailable. Please allow microphone access and retry.');
      setRecordingState('error');
      stopActiveStream();
    }
  }, [clearTimers, processAudioBlob, stopActiveStream, stopRecording]);

  const handleClose = useCallback(() => {
    isClosingRef.current = true;
    clearTimers();

    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors during close.
      }
    }

    stopActiveStream();
    onClose();
  }, [clearTimers, onClose, stopActiveStream]);

  useEffect(() => {
    return () => {
      isClosingRef.current = true;
      clearTimers();

      const recorder = recorderRef.current;
      if (recorder && recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          // Ignore stop errors during unmount.
        }
      }

      stopActiveStream();
    };
  }, [clearTimers, stopActiveStream]);

  const accountOptions = useMemo(
    () => accounts.map((account) => account.name),
    [accounts],
  );

  const updateDraft = useCallback((id: string, updates: Partial<VoiceDraftTransaction>) => {
    setDrafts((prev) => prev.map((draft) => (draft.id === id ? { ...draft, ...updates } : draft)));
  }, []);

  const handleTypeChange = useCallback(
    (draft: VoiceDraftTransaction, nextType: 'income' | 'expense') => {
      const matchingCategories = getCategoryOptionsForType(nextType, categories);
      const categoryStillValid = matchingCategories.some((item) => item.name === draft.category);

      const nextCategory = categoryStillValid
        ? draft.category
        : getDefaultCategoryName(nextType, categories);

      updateDraft(draft.id, {
        type: nextType,
        category: nextCategory,
        subCategory: '',
      });
    },
    [categories, updateDraft],
  );

  const removeDraft = useCallback((id: string) => {
    setDrafts((prev) => prev.filter((draft) => draft.id !== id));
  }, []);

  const addDraft = useCallback(() => {
    setDrafts((prev) => [...prev, createEmptyDraft(categories, accounts)]);
  }, [accounts, categories]);

  const handleSaveAll = useCallback(() => {
    if (drafts.length === 0) {
      setError('No transactions to save.');
      return;
    }

    const invalidDraft = drafts.find((draft) => !Number.isFinite(draft.amount) || draft.amount <= 0);
    if (invalidDraft) {
      setError('Each transaction must have amount greater than 0.');
      return;
    }

    const now = new Date();
    const prepared = drafts.map((draft) => {
      const categoryPool = getCategoryOptionsForType(draft.type, categories);
      const resolvedCategory = categoryPool.some((item) => item.name === draft.category)
        ? draft.category
        : getDefaultCategoryName(draft.type, categories);

      const category = categories.find((item) => item.name === resolvedCategory);
      const validSubCategory = category?.subCategories?.includes(draft.subCategory)
        ? draft.subCategory
        : '';

      const account = accountOptions.includes(draft.account)
        ? draft.account
        : getDefaultAccountName(accounts);

      return {
        amount: Math.round(draft.amount * 100) / 100,
        type: draft.type,
        date: now,
        category: resolvedCategory,
        subCategory: validSubCategory,
        accountId: account,
        description: draft.description.trim() || draft.rawText || 'Voice entry',
      } satisfies Omit<Transaction, 'id'>;
    });

    learnFromFinalizedDrafts(drafts);
    onSaveTransactions(prepared);
  }, [accountOptions, accounts, categories, drafts, onSaveTransactions]);

  return (
    <div className="modal-overlay">
      <div className="modal-content voice-modal-content">
        <div className="modal-header">
          <h2>Voice Transactions</h2>
          <button onClick={handleClose} className="close-btn" aria-label="Close voice modal">
            <X size={22} />
          </button>
        </div>

        <p className="voice-subtitle">Record up to 2 minutes. Add multiple transactions in one go.</p>

        {(recordingState === 'idle' || recordingState === 'error') && (
          <div className="voice-center-actions">
            <Button
              variant="primary"
              onClick={() => {
                void startRecording();
              }}
              className="voice-main-btn"
            >
              <Mic size={18} style={{ marginRight: 8 }} />
              Start Recording
            </Button>
            {error && <div className="voice-error">{error}</div>}
          </div>
        )}

        {recordingState === 'recording' && (
          <div className="voice-recording-panel">
            <div className="voice-recording-status">Recording...</div>
            <div className="voice-timer-row">
              <strong>{formatDuration(elapsedMs)}</strong>
              <span>{formatDuration(remainingMs)} left</span>
            </div>
            <div className="voice-progress-track">
              <div className="voice-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <Button variant="danger" onClick={stopRecording} className="voice-main-btn">
              <Square size={16} style={{ marginRight: 8 }} />
              Stop & Process
            </Button>
          </div>
        )}

        {recordingState === 'processing' && (
          <div className="voice-processing">Processing audio and extracting transactions...</div>
        )}

        {recordingState === 'review' && (
          <div className="voice-review-area">
            <div className="voice-section-title">Transcript</div>
            <textarea className="voice-transcript" value={transcript} readOnly />

            <div className="voice-section-title" style={{ marginTop: 16 }}>
              Parsed Transactions ({drafts.length})
            </div>

            <div className="voice-draft-list">
              {drafts.map((draft) => {
                const categoryOptions = getCategoryOptionsForType(draft.type, categories);
                const selectedCategory = categories.find((item) => item.name === draft.category);
                const subCategoryOptions = selectedCategory?.subCategories || [];

                return (
                  <div key={draft.id} className="voice-draft-card">
                    <div className="voice-draft-top-row">
                      <span className="voice-confidence">Confidence: {Math.round(draft.confidence * 100)}%</span>
                      <button
                        type="button"
                        className="voice-icon-btn"
                        onClick={() => {
                          removeDraft(draft.id);
                        }}
                        aria-label="Delete transaction draft"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="voice-grid-two">
                      <label className="voice-field">
                        <span>Type</span>
                        <select
                          value={draft.type}
                          onChange={(event) => {
                            handleTypeChange(draft, event.target.value as 'income' | 'expense');
                          }}
                        >
                          <option value="expense">Expense</option>
                          <option value="income">Income</option>
                        </select>
                      </label>

                      <label className="voice-field">
                        <span>Amount</span>
                        <input
                          type="number"
                          value={draft.amount}
                          min={0}
                          step="0.01"
                          onChange={(event) => {
                            updateDraft(draft.id, {
                              amount: Number.parseFloat(event.target.value || '0'),
                            });
                          }}
                        />
                      </label>
                    </div>

                    <label className="voice-field">
                      <span>Category</span>
                      <select
                        value={draft.category}
                        onChange={(event) => {
                          updateDraft(draft.id, {
                            category: event.target.value,
                            subCategory: '',
                          });
                        }}
                      >
                        {categoryOptions.map((category) => (
                          <option key={category.id} value={category.name}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {subCategoryOptions.length > 0 && (
                      <label className="voice-field">
                        <span>Sub-category</span>
                        <select
                          value={draft.subCategory}
                          onChange={(event) => {
                            updateDraft(draft.id, { subCategory: event.target.value });
                          }}
                        >
                          <option value="">None</option>
                          {subCategoryOptions.map((subCategory) => (
                            <option key={subCategory} value={subCategory}>
                              {subCategory}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <label className="voice-field">
                      <span>Account</span>
                      <select
                        value={draft.account}
                        onChange={(event) => {
                          updateDraft(draft.id, { account: event.target.value });
                        }}
                      >
                        {accountOptions.map((accountName) => (
                          <option key={accountName} value={accountName}>
                            {accountName}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="voice-field">
                      <span>Note</span>
                      <input
                        type="text"
                        value={draft.description}
                        onChange={(event) => {
                          updateDraft(draft.id, { description: event.target.value });
                        }}
                        placeholder="What was this transaction for?"
                      />
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="voice-action-row">
              <Button variant="secondary" onClick={addDraft}>
                <Plus size={16} style={{ marginRight: 8 }} />
                Add Row
              </Button>
              <Button variant="primary" onClick={handleSaveAll}>
                Save All
              </Button>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setRecordingState('idle');
                setElapsedMs(0);
                setError(null);
              }}
            >
              Start New Voice Session
            </Button>

            {error && <div className="voice-error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
