
import numpy as np
import numpy.typing as npt
import torch
torch.set_num_threads(1)

'''
def get_speech_timestamps(
        audio: torch.Tensor, 
        model, 
        threshold: float = 0.5, 
        sampling_rate: int = 16000, 
        min_speech_duration_ms: int = 250, 
        max_speech_duration_s: float = float('inf'), 
        min_silence_duration_ms: int = 100, 
        speech_pad_ms: int = 30, 
        return_seconds: bool = False, 
        visualize_probs: bool = False, 
        progress_tracking_callback: Callable[[float], None] = None, 
        neg_threshold: float = None, 
        window_size_samples: int = 512,): 
  
     """ 
     This method is used for splitting long audios into speech chunks using silero VAD 
  
     Parameters 
     ---------- 
     audio: torch.Tensor, one dimensional 
         One dimensional float torch.Tensor, other types are casted to torch if possible 
  
     model: preloaded .jit/.onnx silero VAD model 
  
     threshold: float (default - 0.5) 
         Speech threshold. Silero VAD outputs speech probabilities for each audio chunk, probabilities ABOVE this value are considered as SPEECH. 
         It is better to tune this parameter for each dataset separately, but "lazy" 0.5 is pretty good for most datasets. 
  
     sampling_rate: int (default - 16000) 
         Currently silero VAD models support 8000 and 16000 (or multiply of 16000) sample rates 
  
     min_speech_duration_ms: int (default - 250 milliseconds) 
         Final speech chunks shorter min_speech_duration_ms are thrown out 
  
     max_speech_duration_s: int (default -  inf) 
         Maximum duration of speech chunks in seconds 
         Chunks longer than max_speech_duration_s will be split at the timestamp of the last silence that lasts more than 100ms (if any), to prevent agressive cutting. 
         Otherwise, they will be split aggressively just before max_speech_duration_s. 
  
     min_silence_duration_ms: int (default - 100 milliseconds) 
         In the end of each speech chunk wait for min_silence_duration_ms before separating it 
  
     speech_pad_ms: int (default - 30 milliseconds) 
         Final speech chunks are padded by speech_pad_ms each side 
  
     return_seconds: bool (default - False) 
         whether return timestamps in seconds (default - samples) 
  
     visualize_probs: bool (default - False) 
         whether draw prob hist or not 
  
     progress_tracking_callback: Callable[[float], None] (default - None) 
         callback function taking progress in percents as an argument 
  
     neg_threshold: float (default = threshold - 0.15) 
         Negative threshold (noise or exit threshold). If model's current state is SPEECH, values BELOW this value are considered as NON-SPEECH. 
  
     window_size_samples: int (default - 512 samples) 
         !!! DEPRECATED, DOES NOTHING !!! 
  
     Returns 
     ---------- 
     speeches: list of dicts 
         list containing ends and beginnings of speech chunks (samples or seconds based on return_seconds) 
     """ 

     https://github.com/snakers4/silero-vad/discussions/562?utm_source=chatgpt.com
     '''

class PureSilenceDetection:
    def __init__(self, sample_rate: int = 16000, default_silence_threshold: float = 0.01, mix_to_mono = True):
        self.sample_rate = int(sample_rate)
        self.silence_threshold = float(default_silence_threshold)
        self.mix_to_mono = bool(mix_to_mono) # mix multi-D channels into 1D channel
        self._expects_float32 = True
        self.expects_contiguous = True
    
    def pure_silence_detection(self, audio_array: npt.NDArray, silence_threshold: float) -> bool:
        if audio_array is None:
            return True
        
        array = np.asarray(audio_array)

        if array.size == 0:
            return True
        
        if array.ndim > 1:
            array = array.mean(axis = 1)

        array = np.ascontiguousarray(array, dtype = np.float32)

        if array.size == 0:
            return True
        
        max_abs = float(np.max(np.abs(array)))
        rms = float(np.sqrt(np.mean(np.square(array), dtype = np.float64)))
        return (max_abs <= float(silence_threshold)) and (rms <=float(silence_threshold))


class SilenceFiltering:
    """
    Inputs:
        - audio_array: 1D (or multi-channel) numpy array. Prefer float32 normalized to [-1,1].
        - sample_rate: sample rate in Hz
        - silence_threshold: float amplitude threshold to drop low-energy segments
    Output:
        - Returns list of (start_sample, end_sample) tuples (samples relative to input).
    """
    def __init__(
            self,
            audio_array:npt.NDArray,
            sample_rate: int,
            threshold=0.5,
            neg_threshold=None
        ):
        self.sample_rate = int(sample_rate)
        self._vad_model = None
        self._get_speech_timestamps = None
        self.threshold = threshold
        self.neg_threshold = neg_threshold
        array = None
        if audio_array is not None:
            arr = np.asarray(audio_array)
            if arr.ndim > 1:
                arr = arr.mean(axis = 1)
            if arr.size > 0:
                array = np.ascontiguousarray(arr, dtype = np.float32)
            else:
                array = np.empty(0, dtype = np.float32)


        self._array = array
    
    def _ensure_vad_load(self) -> None:
        if self._vad_model is not None:
            return
        
        try:
            model, utils = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model = 'silero_vad',
                forced_reload = False
            )
            model.to('cpu')
            self._vad_model = model
            self._get_speech_timestamps = utils[0]
        except Exception:
            self._vad_model = None
            self._get_speech_timestamps = None
       
       

    def voice_position_detection(self, audio_array: npt.NDArray | None = None) -> list:
        array = None
        if audio_array is not None:
            arr = np.asarray(audio_array)
            if arr.ndim > 1:
                arr = arr.mean(axis = 1)
            array = np.ascontiguousarray(arr, dtype = np.float32)
        elif self._array is not None:
            array = self._array
        else:
            return []
        
        self._ensure_vad_load()
        if self._get_speech_timestamps is None or self._vad_model is None:
            return []
        
        try: 
            # prepare for the future that user can set the threshold, if user does not initialize the threshold, neg_threshold will be 0
            neg_th = self.neg_threshold
            if neg_th is None:
                neg_th = max(0.01, self.threshold - 0.15)
            neg_th = min(neg_th, self.threshold - 0.001)

            with torch.inference_mode():
                wave = torch.from_numpy(array).float()
                if wave.ndim > 1:
                    wave = wave.mean(dim = 1)
                time_stamps = self._get_speech_timestamps(
                    wave,
                    self._vad_model,
                    sampling_rate = self.sample_rate,
                    threshold=self.threshold, # above the threshold value -> start vad, recommend value is 0.5
                    neg_threshold = neg_th, # below than neg_threshold -> stop vad, default value is threshold - 0.15
                    return_seconds = False
                )
        except Exception:
            return []
        
        if not time_stamps:
            return []

        ranges = []

        length = len(wave)
        for time in time_stamps:
            try:
                start = int(time.get("start", 0))
                end = int(time.get("end", 0))

                start = max(0, min(start, length))
                end = max(0, min(end, length))
                if end > start:
                    ranges.append((start, end))
            except Exception:
                continue
        return ranges


    def destroy_vad(self):
        try:
            if getattr(self,"_vad_model", None) is not None:
                if hasattr(self._vad_model, "unload_model"):
                    try:
                        self._vad_model.unload_model()
                    except Exception:
                        pass    
                self._vad_model = None
            self._get_speech_timestamps = None
            torch.hub._hub_dir = None
        except Exception:
            self._vad_model = None
            self._get_speech_timestamps = None
            torch.hub._hub_dir = None
