# Revision of draft 1: Nocturne in D-flat major, solo piano, 4/4.
from eng import *
A=[('Db:M',"Ab4:1 F5:2 Eb5:0.5 Db5:0.5"),('Gb:M/Db',"Db5:1.5 Bb4:0.5 Gb4:1 Bb4:1"),
   ('Db:M/Ab',"Ab4:1 Db5:1 F5:1.5 Ab5:0.5"),('Ab:7',"Gb5:2 F5:0.5 Eb5:0.5 C5:1"),
   ('Bb:m',"Db5:1 F5:2 Eb5:0.5 Db5:0.5"),('Gb:M',"Db5:1 C5:0.25 Db5:0.25 Bb4:0.5 Gb4:1 Ab4:1"),
   ('Eb:m7',"Gb4:1 Bb4:1 Db5:1 Eb5:0.5 F5:0.5"),('Ab:7',"Eb5:3 r:1")]
A2=[A[0],('Gb:M/Db',"Db5:1 Eb5:0.25 Db5:0.25 Bb4:0.5 Gb4:1 Bb4:1"),('F:m',"Ab4:1 C5:1 F5:1.5 Ab5:0.5"),('Bb:m',"Bb5:2 Ab5:0.5 Gb5:0.5 F5:1"),
    ('Gb:M',"Gb5:1.5 F5:0.5 Eb5:0.5 Db5:0.5 Bb4:1"),('Db:M/Ab',"Ab4:1 Db5:1 F5:1 Eb5:1"),
    ('Ab:7',"Gb5:1.5 F5:0.5 Eb5:1 C5:1"),('Db:M',"Db5:3 r:1")]
B=[('Bb:m',"F5:1.5 Gb5:0.5 F5:1 Db5:1"),('Eb:m/Gb',"Eb5:1.5 F5:0.5 Gb5:1 Bb5:1"),
   ('F:7',"A5:1 Bb5:0.5 C6:0.5 A5:1 Eb5:1"),('Bb:m',"Db5:1.5 C5:0.5 Db5:1 F5:1"),
   ('Gb:M',"Gb5:1.5 F5:0.5 Eb5:1 Db5:1"),('Ab:7',"C5:0.5 Eb5:0.5 Gb5:0.5 Ab5:0.5 C6:1 Bb5:0.5 Ab5:0.5")]
A3=[A[0],('Gb:m/Db',"Db5:1.5 A4:0.5 Gb4:1 A4:1"),('Db:M/Ab',"Ab4:1 Db5:1 F5:1.5 Eb5:0.5"),('Ab:7',"Gb5:2 Eb5:1 C5:1")]
CO=[('Gb:M/Db',"Db5:1 F5:1 Bb5:1.5 Ab5:0.5")]
END=[('Db:M',"Db5:4")]
plan=[('A',A,(50,60),76,'broken8',3),("A'",A2,(54,66),76,'broken8',5),('B, B-flat minor (agitato)',B,(56,76),80,('arp16',46,70),5),
      ("A'' (with G-flat minor color)",A3,(52,58),74,'broken8',6),('Coda',CO,(46,40),68,'broken8',6),('end',END,(38,38),56,'end',0)]
build(plan,(4,4),solo=None,out='rev',agogic=[1.0,1.02,1.0,0.96])
