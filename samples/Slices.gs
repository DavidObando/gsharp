// file: Slices.gs
// Demonstrates Phase 3.A.2 emit coverage: variable-length slice types,
// composite literals, indexing, and the len / cap / append intrinsics.
// Issue #723 / ADR-0083: the `len`, `cap`, and `append` built-ins are
// gated behind `import Gsharp.Extensions.Go`; this sample keeps the
// Go-flavored shapes intentionally because slices and `append` are
// part of that surface.

package GSharp.Example.Slices

import System
import Gsharp.Extensions.Go

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
for i in 0 ... len(nums) {
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
