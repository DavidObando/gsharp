package Examples.Bindings

import System

let values = []int32{10, 20, 30}
var count int32 = 0
for value in values {
    count++
}
Console.WriteLine(count)
