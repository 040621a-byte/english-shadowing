// 语音能力封装：朗读（TTS）、录音（MediaRecorder）、语音识别（SpeechRecognition）。
// 浏览器能力差异很大，这里统一做能力探测与中文错误提示，避免界面出现"点了没反应"。

const hasWindow = typeof window !== 'undefined';
const SRClass = hasWindow ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const ERROR_TEXT = {
  'mic-denied': '麦克风权限被拒绝，请在浏览器地址栏左侧的权限设置里允许麦克风后重试',
  'mic-error': '无法打开麦克风，请检查设备是否有可用的麦克风',
  'no-recording': '此浏览器不支持录音回听，本次只提供评分',
  'insecure-no-recording': '当前不是 HTTPS 环境，浏览器不允许录音回听；本次只提供跟读打分',
  'no-recognition': '此浏览器不支持语音识别打分（需要 Chrome 浏览器），可以录音回听对比',
  'recognizer-not-allowed': '语音识别被拒绝，请允许麦克风权限后重试',
  'recognizer-network': '语音识别需要联网，请检查网络后重试',
  'recognizer-audio': '没有捕获到声音，请靠近麦克风再试一次',
  'recognizer-error': '语音识别出错了，请再试一次',
};

export function isTtsSupported() {
  return hasWindow && 'speechSynthesis' in window;
}

export function isRecordingSupported() {
  return (
    hasWindow &&
    typeof window.MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
}

export function isRecognitionSupported() {
  return Boolean(SRClass);
}

export function isSecure() {
  return hasWindow ? window.isSecureContext !== false : false;
}

export function getCapabilities() {
  return {
    tts: isTtsSupported(),
    recording: isRecordingSupported(),
    recognition: isRecognitionSupported(),
    secure: isSecure(),
  };
}

/* ---------------------------------- 朗读 ---------------------------------- */

export function listEnglishVoices() {
  if (!isTtsSupported()) return [];
  return window.speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
}

/** 某些浏览器首次 getVoices() 返回空，需要等 voiceschanged */
export function primeVoices() {
  return new Promise((resolve) => {
    if (!isTtsSupported()) {
      resolve([]);
      return;
    }
    const existing = listEnglishVoices();
    if (existing.length) {
      resolve(existing);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(listEnglishVoices());
    };
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, 1500);
  });
}

/**
 * 朗读一句英文。无论成功失败都会 resolve，避免界面卡住。
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export function speak(text, { rate = 1, lang = 'en-US' } = {}) {
  return new Promise((resolve) => {
    if (!isTtsSupported()) {
      resolve({ ok: false, message: '此设备不支持语音朗读' });
      return;
    }
    const synth = window.speechSynthesis;
    try {
      synth.cancel();
    } catch {
      /* 忽略 */
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    utter.rate = rate;
    const voices = listEnglishVoices();
    const preferred = voices.find((v) => /en[-_]us/i.test(v.lang)) || voices[0];
    if (preferred) utter.voice = preferred;

    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    utter.onend = () => done({ ok: true });
    utter.onerror = () => done({ ok: false, message: '朗读失败，请检查系统语音设置' });
    try {
      synth.speak(utter);
    } catch {
      done({ ok: false, message: '朗读失败，请检查系统语音设置' });
      return;
    }
    // 兜底：部分安卓浏览器不触发 onend
    setTimeout(() => done({ ok: true }), Math.max(4000, text.length * 400));
  });
}

export function stopSpeaking() {
  if (isTtsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* 忽略 */
    }
  }
}

/* --------------------------------- 跟读会话 -------------------------------- */

function pickRecorderMime() {
  if (!hasWindow || typeof window.MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const type of candidates) {
    if (window.MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return '';
}

/**
 * 一次跟读：同时启动麦克风录音与语音识别。
 * 识别到最终结果后静默 silenceMs 毫秒自动结束，或到达 maxMs 上限。
 */
export class ShadowSession {
  constructor({
    lang = 'en-US',
    maxMs = 15000,
    silenceMs = 1100,
    useRecognition = true,
    fallbackMs = 8000,
  } = {}) {
    this.lang = lang;
    this.maxMs = maxMs;
    this.silenceMs = silenceMs;
    this.useRecognition = useRecognition;
    // 没有语音识别时无法判断用户是否读完，用估算时长兜底自动结束
    this.fallbackMs = fallbackMs;
    this.supported = { recording: isRecordingSupported(), recognition: isRecognitionSupported() };
    this.errorCode = null;
    this.errorMessage = null;
    this.finalText = '';
    this.partialText = '';
    this.audioUrl = null;
    this.recordingEmpty = false;
    this.recognizedAnything = false;
    this.active = false;
  }

  setError(code, message = ERROR_TEXT[code] ?? '出错了') {
    if (this.errorCode) return;
    this.errorCode = code;
    this.errorMessage = message;
  }

  async start() {
    this.active = true;
    let micBlocked = false;

    if (this.supported.recording) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        const mime = pickRecorderMime();
        this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
        this.chunks = [];
        this.recorder.ondataavailable = (event) => {
          if (event.data && event.data.size) this.chunks.push(event.data);
        };
        this.recorder.start(200);
      } catch (err) {
        const name = err?.name ?? '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          micBlocked = true;
          this.setError('mic-denied');
        } else {
          this.setError('mic-error');
        }
      }
    } else {
      this.setError(isSecure() ? 'no-recording' : 'insecure-no-recording');
    }

    if (!this.useRecognition) {
      // 用户在产品设置里关掉了自动打分
    } else if (!this.supported.recognition) {
      this.setError('no-recognition');
    } else if (!micBlocked) {
      this.startRecognition();
    }

    const limit = this.recognitionStarted
      ? this.maxMs
      : Math.min(this.maxMs, this.fallbackMs);
    this.maxTimer = setTimeout(() => this.autoStop(), limit);

    return this;
  }

  startRecognition() {
    let recognition;
    try {
      recognition = new SRClass();
    } catch {
      this.setError('no-recognition');
      return;
    }
    this.recognition = recognition;
    recognition.lang = this.lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    this.recognitionEnded = new Promise((resolve) => {
      this.resolveRecognitionEnded = resolve;
    });

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          this.finalText += `${text} `;
          this.recognizedAnything = true;
        } else {
          interim += text;
        }
      }
      this.partialText = interim.trim();
      if (this.onPartial) this.onPartial(this.partialText || this.finalText.trim());
      if (this.partialText === '' && this.finalText.trim()) {
        // 识别到最终结果后给一点时间让用户把话说完
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => this.autoStop(), this.silenceMs);
      }
    };

    recognition.onerror = (event) => {
      const code = event?.error ?? '';
      if (code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') this.setError('recognizer-not-allowed');
      else if (code === 'network') this.setError('recognizer-network');
      else if (code === 'audio-capture') this.setError('recognizer-audio');
      else if (code === 'no-speech') this.setError('recognizer-no-speech', '没有听清，请靠近麦克风再读一遍');
      else this.setError('recognizer-error');
    };

    recognition.onend = () => {
      this.recognitionEndedFlag = true;
      this.resolveRecognitionEnded?.();
      // 识别自己结束了（例如没听到人声）而界面还没收到结果时，尽快收尾，
      // 不然用户要一直等到 maxMs 上限才会看到反馈
      if (!this.stoppingPromise) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => this.autoStop(), 400);
      }
    };

    try {
      recognition.start();
      this.recognitionStarted = true;
    } catch {
      this.setError('recognizer-error');
      this.resolveRecognitionEnded?.();
    }
  }

  /** 结束本次跟读，返回结果（可重复调用，以第一次为准） */
  async stop() {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stoppingPromise = this.finish();
    return this.stoppingPromise;
  }

  /** 由计时器触发的自动结束：先开始收尾，再通知界面来取结果 */
  autoStop() {
    this.stop();
    if (this.onAutoStop) this.onAutoStop();
  }

  async finish() {
    this.active = false;
    clearTimeout(this.maxTimer);
    clearTimeout(this.silenceTimer);

    if (this.recognition && !this.recognitionEndedFlag) {
      try {
        this.recognition.stop();
      } catch {
        /* 忽略 */
      }
      await Promise.race([
        this.recognitionEnded ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
      try {
        this.recognition.abort();
      } catch {
        /* 忽略 */
      }
    }

    if (this.recorder && this.recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        const done = () => resolve();
        this.recorder.addEventListener('stop', done, { once: true });
        try {
          this.recorder.stop();
        } catch {
          done();
        }
        setTimeout(done, 1000);
      });
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }

    if (this.chunks && this.chunks.length) {
      const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' });
      this.audioBlob = blob;
      // 极小的文件说明录音基本是空的，多半是识别服务占用了麦克风
      this.recordingEmpty = blob.size < 1200;
      if (!this.recordingEmpty) this.audioUrl = URL.createObjectURL(blob);
    }

    return this.result();
  }

  result() {
    const transcript = this.finalText.replace(/\s+/g, ' ').trim();
    return {
      transcript,
      partial: this.partialText,
      audioUrl: this.audioUrl,
      audioBlob: this.audioBlob,
      recordingEmpty: this.recordingEmpty,
      recognizedAnything: this.recognizedAnything,
      errorCode: this.errorCode,
      errorMessage: this.errorMessage,
      supported: { ...this.supported },
      usedRecognition: Boolean(this.recognitionStarted),
    };
  }

  /** 放弃这次跟读，不保留录音 */
  cancel() {
    clearTimeout(this.maxTimer);
    clearTimeout(this.silenceTimer);
    try {
      this.recognition?.abort();
    } catch {
      /* 忽略 */
    }
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* 忽略 */
    }
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.active = false;
  }
}
