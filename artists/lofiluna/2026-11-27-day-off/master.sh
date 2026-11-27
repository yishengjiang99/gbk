# final master for Day Off: low shelf -3 dB @140, high shelf +3 dB @4k, +16 dB into a limiter, then master.py (vinyl, fade, linear loudnorm -16 LUFS)
set -e
ffmpeg -hide_banner -loglevel error -y -i d1_r4/gbk_raw.wav -af "bass=g=-3:f=140:t=s,treble=g=3:f=4000:t=s,volume=16dB,alimiter=limit=0.6:attack=5:release=80:level=false" -c:a pcm_f32le /tmp/day_off_eq.wav
python3 master.py /tmp/day_off_eq.wav day_off.wav 3.5
ffmpeg -hide_banner -loglevel error -y -i day_off.wav -codec:a libmp3lame -b:a 192k -id3v2_version 3 -metadata title="Day Off" -metadata artist="Lofi Luna" -metadata genre="Lofi" day_off.mp3
