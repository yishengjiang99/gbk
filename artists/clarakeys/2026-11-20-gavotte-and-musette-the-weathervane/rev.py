# Revision of draft 1: Gavotte and Musette in B-flat major, bassoon and piano, 4/4.
from eng import *
A=[('Bb:M',"r:2 D4:1 F4:1"),('Eb:M',"G4:1.5 F4:0.5 Eb4:1 G4:1"),
   ('Bb:M/F',"F4:1.5 D4:0.5 Bb3:1 D4:1"),('F:7',"C4:1.5 Eb4:0.5 C4:1 A3:1"),
   ('G:m',"Bb3:1 D4:1 G4:1.5 F4:0.5"),('C:7',"E4:1 G4:1 Bb4:1 G4:1"),
   ('F:M/C',"A4:1.5 G4:0.5 F4:1 E4:1"),('F:M',"F4:2 D4:1 F4:1")]
A2=[('Eb:M',"G4:1.5 F4:0.5 Eb4:1 G4:1"),('Bb:M/F',"F4:1.5 D4:0.5 Bb3:1 D4:1"),
    ('C:m',"Eb4:1 G4:1 C5:1.5 Bb4:0.5"),('F:7/A',"A4:1.5 Bb4:0.5 C5:1 Eb5:1"),
    ('Bb:M/D',"D5:1.5 C5:0.5 Bb4:1 F4:1"),('F:7',"Eb4:1.5 D4:0.5 C4:1 A3:1"),
    ('Bb:M',"Bb3:2 D4:1 F4:1")]
MU=[('Eb:M',"G4:2 Bb4:1 G4:1"),('Ab:M/Eb',"Ab4:1.5 C5:0.5 Eb5:1 C5:1"),
    ('Eb:M',"G4:1 F4:0.5 G4:0.5 Eb4:2"),('Bb:7/Eb',"F4:1.5 G4:0.5 Ab4:1 F4:1"),
    ('Eb:M',"G4:2 Bb4:1 Eb5:1"),('Ab:M/Eb',"C5:1.5 Bb4:0.5 Ab4:1 C5:1"),
    ('Eb:M',"Eb4:2 G4:1 Bb4:1"),('Bb:7',"Ab4:1 F4:1 D4:1 F4:1")]
A3=[('Eb:M',"G4:0.5 Bb4:0.5 G4:0.5 F4:0.5 Eb4:1 G4:1"),A2[1],A2[2],
    ('F:7/A',"A4:1.5 Bb4:0.5 C5:0.5 D5:0.5 Eb5:1"),('Bb:M/D',"F5:1.5 D5:0.5 Bb4:1 F4:1"),A2[5],
    ('Bb:M',"Bb3:2 G3:1 Bb3:1")]
CO=[('Eb:M/G',"Eb4:1 Bb3:1 G3:1.5 A3:0.5"),('F:7',"Eb4:1 C4:1 A3:1 F3:1")]
END=[('Bb:M',"Bb3:1 Bb2:1 r:2")]
G=('gav',65,79)
plan=[('A',A,(58,68),104,G,3),("A'",A2,(62,74),104,G,6),('Musette, E-flat major',MU,(44,54),92,('musette',55,67),7),
      ("A'' (da capo, forte)",A3,(66,78),104,G,6),('Coda',CO,(58,44),96,G,12),('end',END,(46,46),76,('end',58,74),0)]
build(plan,(4,4),solo=('Bassoon',70),out='rev',detach=True)
