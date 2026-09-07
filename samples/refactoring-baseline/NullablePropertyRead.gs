// file: NullablePropertyRead.gs
// Issue #504/#517 (both fixed): reading a CLR property whose declared type is
// Nullable[T] must emit verifiable IL. Uses a BCL property
// (TimeSpan?.HasValue / .Value) to pin the lifted member-access shape.

package GSharp.Refactoring.NullablePropertyRead

import System

var x int32? = 7
Console.WriteLine(x.HasValue)
Console.WriteLine(x.Value)
