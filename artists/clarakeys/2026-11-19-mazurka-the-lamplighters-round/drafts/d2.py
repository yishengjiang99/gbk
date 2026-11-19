# Draft 2: Prelude in D-flat major, solo piano, 4/4 Lento, sixteenth arpeggios.
from eng import *
A=[('Db:M',"F5:1.5 Eb5:0.5 Db5:1 Ab5:1"),('Gb:M/Db',"Bb5:2 Ab5:1 Gb5:1"),
   ('Bb:m',"F5:1.5 Gb5:0.5 Ab5:1 Db6:1"),('Ab:7',"C6:2 Bb5:1 Ab5:1"),
   ('Gb:M',"Bb5:1.5 Ab5:0.5 Gb5:1 Eb5:1"),('Db:M/F',"F5:1 Ab5:1 Db6:1.5 C6:0.5"),
   ('Ab:7',"Eb5:1.5 F5:0.5 Gb5:1 C5:1"),('Db:M',"Db5:3 r:1")]
B=[('Bb:m',"Db6:1.5 C6:0.5 Bb5:1 F5:1"),('Eb:m',"Gb5:2 Bb5:1 Eb6:1"),
   ('C:hd7',"Eb6:1.5 Db6:0.5 C6:1 Gb5:1"),('F:7',"A5:2 C6:1 Eb6:1"),
   ('Gb:M7',"Db6:1.5 Bb5:0.5 F5:1 Gb5:1"),('Ab:7',"Eb5:1 Gb5:1 C6:1 Ab5:1")]
A2=[('Db:M',"F5:1.5 Eb5:0.5 Db5:1 Ab5:1"),('Gb:m/Db',"A5:2 Ab5:1 Gb5:1"),
    ('Db:M/Ab',"F5:2 Eb5:1 Db5:1"),('Ab:7',"Eb5:2 Gb5:1 C5:1")]
CO=[('Gb:M/Db',"Bb4:2 Ab4:2"),('Db:M',"Db5:4")]
plan=[('A',A,(50,62),58,'arp16',4),('B, B-flat minor',B,(58,78),62,'arp16',5),("A'",A2,(56,50),56,'arp16',5),
      ('Coda',CO[:1],(46,46),50,'arp16',0),('end',CO[1:],(40,40),46,'end',0)]
build(plan,(4,4),out='d2')
