// inventory: CoalesceAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class CoalesceAssignmentExpressionFixture
    {
        public static void Run()
        {
            string? name = null;
            name ??= "fallback";
            string? keep = "kept";
            keep ??= "ignored";

            // Issue #1916: value-type Nullable<T> ??= targets used to fail
            // ilverify (StackUnexpected) when the reassigned local was later
            // interpolated. Cover the value-type path alongside the
            // reference-type one above so the grid stays a parity oracle for
            // it.
            int? count = null;
            count ??= 9;
            int? keptCount = 3;
            keptCount ??= 99;
            Console.WriteLine($"CoalesceAssignmentExpression: name={name} keep={keep} count={count} keptCount={keptCount}");
        }
    }
}
