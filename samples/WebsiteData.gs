package Website.Data

import System

data class Point(X int32, Y int32)

let origin = Point(0, 0)
let moved = origin with { X = 3 }

Console.WriteLine("(${moved.X}, ${moved.Y})")
Console.WriteLine(origin == Point(0, 0))
