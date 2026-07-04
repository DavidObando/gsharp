// inventory: RefType — issue #1900: `ref int` local aliasing an array
// element ('ref int first = ref data[0]') and a genuine ref-returning method
// ('ref int Middle(...)' / 'return ref values[1]'), read by value at the call
// site rather than re-aliased. Maps to G#'s native ref-aliasing local
// (`let/var ref name T = lvalue`) and native ref-returning function
// (`func F(...) ref T { return ref lvalue }`, ADR-0060 follow-up). See
// Quarantined/RefTypeCallAlias.cs.txt for re-aliasing a ref-returning call's
// result, which has no native G# form.
using System;

namespace Corpus.Grid12.Constructs
{
    public static class RefTypeFixture
    {
        public static void Run()
        {
            int[] data = new int[] { 1, 2, 3 };
            ref int first = ref data[0];
            first = 10;

            int middle = Middle(data);
            middle += 5;

            Console.WriteLine($"RefType: data={data[0]},{data[1]},{data[2]}, middle={middle}");
        }

        private static ref int Middle(int[] values)
        {
            return ref values[1];
        }
    }
}
