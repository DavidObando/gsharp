// file: Slices.gs
// Demonstrates Phase 3.A.2 emit coverage: variable-length slice types,
// composite literals, and indexing. A slice (`[]T`) is a fixed CLR array,
// so its length is `.Length`; the growable shape is `List[T]` + `Add`
// (ADR-0174 D13 retired the `len` / `cap` / `append` built-ins).

package GSharp.Example.Slices

import System
import System.Collections.Generic

var nums = []int32{10, 20, 30}
Console.WriteLine(nums.Length)
Console.WriteLine(nums[0])
Console.WriteLine(nums[1])
Console.WriteLine(nums[2])

var grown = List[int32]()
for n in nums {
    grown.Add(n)
}
grown.Add(40)
Console.WriteLine(grown.Count)
Console.WriteLine(grown[3])

var sum = 0
for i in 0 ... grown.Count {
    sum = sum + grown[i]
}

Console.WriteLine(sum)

var words = List[string]()
words.Add("alpha")
words.Add("beta")
words.Add("gamma")
Console.WriteLine(words.Count)
Console.WriteLine(words[0])
Console.WriteLine(words[2])

Console.WriteLine("hello".Length)
