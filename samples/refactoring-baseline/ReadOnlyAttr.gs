// file: ReadOnlyAttr.gs
// Wave-1 P3-11: `inline struct` triggers IsReadOnlyAttribute emit on the
// TypeDef. Locks the attribute-emission shape for the readonly axis.

package GSharp.Refactoring.ReadOnlyAttr

import System

inline struct UserId(value string)

func showLen(id UserId) int32 {
    let (raw) = id
    return raw.Length
}

let u = UserId("alpha")
Console.WriteLine(showLen(u))
