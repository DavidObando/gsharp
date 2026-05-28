// file: Arrays.gs
// Demonstrates Phase 3.A.1 / 3.A.3 emit coverage: fixed-length array types,
// composite literals, index read, and indexed assignment.

package GSharp.Example.Arrays

import System

var nums = [3]int32{10, 20, 30}
Console.WriteLine(nums[0])
Console.WriteLine(nums[1])
Console.WriteLine(nums[2])

nums[1] = 99
Console.WriteLine(nums[1])

var names = [2]string{"alpha", "beta"}
Console.WriteLine(names[0])
Console.WriteLine(names[1])

var sum = 0
for i := 0 ... 3 {
    sum = sum + nums[i]
}

Console.WriteLine(sum)
