package Website.NativeSlices

import System

let values = slice[int32].Create(2, 4)
values[0] = 7
let view = values[0 .. 1]
view[0] = 9
let copied = values.Clone()
copied[0] = 1
Console.WriteLine(values[0])
Console.WriteLine(copied[0])
