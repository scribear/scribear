#!/bin/bash

# Generate Bb Major IV, V, iii, vi cords using sine waves
#   with each cord appearin 1 second after the other
#   and pad all to 4 seconds with silence
ffmpeg \
    -f lavfi -i "aevalsrc=0.2*(sin(2*PI*311.13*t)+sin(2*PI*392.00*t)+sin(2*PI*466.16*t)):d=1:s=48000" \
    -filter_complex "[0:a]adelay=0s:all=true,apad=pad_dur=3[a];" \
    -map "[a]" \
    -ac 1 \
    -ar 48000 \
    -acodec pcm_f64le \
    -f f64le \
    ch0_f64le.pcm

ffmpeg \
    -f lavfi -i "aevalsrc=0.2*(sin(2*PI*349.23*t)+sin(2*PI*440.00*t)+sin(2*PI*523.25*t)):d=1:s=48000" \
    -filter_complex "[0:a]adelay=1s:all=true,apad=pad_dur=2[a];" \
    -map "[a]" \
    -ac 1 \
    -ar 48000 \
    -acodec pcm_f64le \
    -f f64le \
    ch1_f64le.pcm

ffmpeg \
    -f lavfi -i "aevalsrc=0.2*(sin(2*PI*293.66*t)+sin(2*PI*349.23*t)+sin(2*PI*440.00*t)):d=1:s=48000" \
    -filter_complex "[0:a]adelay=2s:all=true,apad=pad_dur=1[a];" \
    -map "[a]" \
    -ac 1 \
    -ar 48000 \
    -acodec pcm_f64le \
    -f f64le \
    ch2_f64le.pcm

ffmpeg \
    -f lavfi -i "aevalsrc=0.2*(sin(2*PI*392.00*t)+sin(2*PI*466.16*t)+sin(2*PI*587.33*t)):d=1:s=48000" \
    -filter_complex "[0:a]adelay=3s:all=true,apad=pad_dur=0[a];" \
    -map "[a]" \
    -ac 1 \
    -ar 48000 \
    -acodec pcm_f64le \
    -f f64le \
    ch3_f64le.pcm


# Generate a IV-V-iii-vi progression and place each chord on a different audio channel
ffmpeg \
    -f f64le -ar 48000 -ac 1 -i ch0_f64le.pcm \
    -f f64le -ar 48000 -ac 1 -i ch1_f64le.pcm \
    -f f64le -ar 48000 -ac 1 -i ch2_f64le.pcm \
    -f f64le -ar 48000 -ac 1 -i ch3_f64le.pcm \
    -filter_complex "[0:a][1:a][2:a][3:a]amerge=inputs=4[a]" \
    -map "[a]" \
    -ac 4 \
    -ar 48000 \
    -acodec pcm_f64le \
    -f f64le \
    quad_f64le.pcm

# Downmix to mono
ffmpeg -f f64le -ar 48000 -ac 4 -i quad_f64le.pcm -ac 1 -ar 48000 -acodec pcm_f64le -f f64le mono_f64le.pcm

# Generate WAV files with different channel counts
ffmpeg -f f64le -ar 48000 -ac 4 -i quad_f64le.pcm -ac 4 -ar 48000 -acodec pcm_f64le quad_f64le.wav
ffmpeg -f f64le -ar 48000 -ac 1 -i mono_f64le.pcm -ac 1 -ar 48000 -acodec pcm_f64le mono_f64le.wav

# Generate WAV files in different formats
ffmpeg -f f64le -ar 48000 -ac 4 -i quad_f64le.pcm -ac 4 -ar 48000 -acodec pcm_f32le quad_f32le.wav
ffmpeg -f f64le -ar 48000 -ac 4 -i quad_f64le.pcm -ac 4 -ar 48000 -acodec pcm_s16le quad_s16le.wav
ffmpeg -f f64le -ar 48000 -ac 4 -i quad_f64le.pcm -ac 4 -ar 48000 -acodec pcm_u8    quad_u8.wav
