package Examples.Swift

import System

data struct Point {
    var X int32
    var Y int32
}

func describe(point Point?) string {
    guard let known = point else { return "no position" }
    return "${known.X}, ${known.Y}"
}

let origin = Point{X: 0, Y: 0}
let moved = origin with { X = 3 }
Console.WriteLine(describe(moved))
Console.WriteLine(describe(nil))
Console.WriteLine(origin == Point{X: 0, Y: 0})
