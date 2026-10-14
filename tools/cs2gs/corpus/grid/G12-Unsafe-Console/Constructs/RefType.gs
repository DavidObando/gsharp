// inventory: RefType — issue #1900: `ref int` local aliasing an array
// element ('ref int first = ref data[0]') and a genuine ref-returning method
// ('ref int Middle(...)' / 'return ref values[1]'), read by value at the call
// site rather than re-aliased. Maps to G#'s native ref-aliasing local
// (`let/var ref name T = lvalue`) and native ref-returning function
// (`func F(...) ref T { return ref lvalue }`, ADR-0060 follow-up). See
// Quarantined/RefTypeCallAlias.cs.txt for re-aliasing a ref-returning call's
// result, which has no native G# form.

package Corpus.Grid12.Constructs

import System

shared class RefTypeFixture {
    func Run() {
        let data = []int32{1, 2, 3}
        var ref first int32 = data[0]
        first = 10
        var middle = Middle(data)
        middle += 5
        Console.WriteLine("RefType: data=${data[0]},${data[1]},${data[2]}, middle=$middle")
    }

    private func Middle(values[]int32) ref int32 {
        return ref values[1]
    }
}
