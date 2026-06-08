// file: RefStructByRefLike.gs
// Wave-1 P3-11: a user `ref struct` triggers IsByRefLikeAttribute (and the
// C# guard [Obsolete]) emit. Locks the attribute-emission shape.

package GSharp.Refactoring.RefStructByRefLike

import System

type Acc ref struct {
    Total int32
}

func bump(a Acc, n int32) Acc {
    return Acc{Total: a.Total + n}
}

func runTotal() int32 {
    var a = Acc{Total: 0}
    a = bump(a, 3)
    a = bump(a, 4)
    return a.Total
}

Console.WriteLine(runTotal())

