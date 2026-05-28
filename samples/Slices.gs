// file: Slices.gs
// Demonstrates Phase 3.A.2 emit coverage: variable-length slice types,
// composite literals, indexing, and the len / cap / append intrinsics.

package GSharp.Example.Slices

import System

var nums = []int32{10, 20, 30}
Console.WriteLine(len(nums))
Console.WriteLine(cap(nums))
Console.WriteLine(nums[0])
Console.WriteLine(nums[1])
Console.WriteLine(nums[2])

nums = append(nums, 40)
Console.WriteLine(len(nums))
Console.WriteLine(nums[3])

var sum = 0
for i := 0 ... len(nums) {
    sum = sum + nums[i]
}

Console.WriteLine(sum)

var words = []string{"alpha"}
words = append(words, "beta")
words = append(words, "gamma")
Console.WriteLine(len(words))
Console.WriteLine(words[0])
Console.WriteLine(words[2])

Console.WriteLine(len("hello"))
