// file: SlicePattern.gs
//
// Issue #1505: slice ("rest") subpatterns in list patterns. Exercises the
// discard slice (..) and the captured slice (..rest) end-to-end through gsc,
// covering [1, .., 3], [.., last], [first, ..], [..], and [first, ..rest, last].

package GSharp.Samples.SlicePattern

import System

func classify(xs []int32) {
  switch xs {
    case [1, .., 3] { Console.WriteLine("bookend") }
    default { Console.WriteLine("other") }
  }
}

func ends(xs []int32) {
  switch xs {
    case [.., l is int32] { Console.WriteLine("last=${l}") }
    case [..] { Console.WriteLine("empty") }
    default { Console.WriteLine("other") }
  }
}

func heads(xs []int32) {
  switch xs {
    case [f is int32, ..] { Console.WriteLine("first=${f}") }
    default { Console.WriteLine("none") }
  }
}

func middle(xs []int32) {
  switch xs {
    case [f is int32, ..rest, l is int32] {
      Console.WriteLine("first=${f} last=${l} restLen=${rest.Length}")
    }
    default { Console.WriteLine("nomatch") }
  }
}

classify([]int32{1, 2, 3})
classify([]int32{1, 9, 9, 9, 3})
classify([]int32{2, 3})
ends([]int32{100, 200})
ends([]int32{})
heads([]int32{42, 1})
heads([]int32{})
middle([]int32{10, 20, 30, 40})
middle([]int32{7, 8})
middle([]int32{5})
