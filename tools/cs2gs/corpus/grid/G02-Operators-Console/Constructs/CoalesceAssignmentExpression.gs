// inventory: CoalesceAssignmentExpression

package Corpus.Grid02

import System

shared class CoalesceAssignmentExpressionFixture {
    func Run() {
        var name string? = nil
        name ??= "fallback"
        var keep string? = "kept"
        keep ??= "ignored"
        // Issue #1916: value-type Nullable<T> ??= targets used to fail
        // ilverify (StackUnexpected) when the reassigned local was later
        // interpolated. Cover the value-type path alongside the
        // reference-type one above so the grid stays a parity oracle for
        // it.
        var count int32? = nil
        count ??= 9
        var keptCount int32? = 3
        keptCount ??= 99
        Console.WriteLine("CoalesceAssignmentExpression: name=$name keep=$keep count=$count keptCount=$keptCount")
    }
}
