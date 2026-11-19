# Draft 3: Arietta in F major, horn and piano, 4/4 Andante.
from eng import *
A=[('F:M',"C4:1 F4:1.5 G4:0.5 A4:1"),('Bb:M/D',"Bb4:2 A4:1 G4:1"),
   ('C:7/E',"G4:1.5 Bb4:0.5 A4:1 G4:1"),('F:M',"F4:3 C4:1"),
   ('D:m',"D4:1 F4:1 A4:1.5 D5:0.5"),('G:7',"D5:2 C5:1 B4:1"),
   ('C:7',"C5:1.5 E4:0.5 G4:1 Bb4:1"),('C:M',"C5:3 r:1")]
B=[('Bb:M',"D5:1.5 C5:0.5 Bb4:1 F4:1"),('G:m7',"Bb4:2 A4:1 G4:1"),
   ('A:7',"E4:1 G4:1 C#5:1.5 A4:0.5"),('D:m',"D5:2 F5:1 D5:1"),
   ('Bb:M',"F5:1.5 D5:0.5 Bb4:1 G4:1"),('C:7',"E4:1 G4:1 Bb4:1 C5:1")]
A2=[('F:M',"C4:1 F4:1.5 G4:0.5 A4:1"),('Bb:M/D',"Bb4:2 D5:1 F5:1"),
    ('F:M/C',"C5:2 A4:1 F4:1"),('C:7',"G4:2 Bb4:1 E4:1")]
CO=[('F:M',"F4:4")]
plan=[('A',A,(52,64),72,'broken8',5),('B, D minor',B,(60,80),74,'broken8',5),("A'",A2,(62,52),70,'broken8',6),('end',CO,(44,44),60,'end',0)]
build(plan,(4,4),solo=('Horn',60),out='d3')
