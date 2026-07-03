// inventory: OmittedTypeArgument — nameof of an unbound generic (C#14 probe)
// QUARANTINED sub-probe: typeof of an unbound generic (`typeof(List<>)`,
// `typeof(Dictionary<,>)`) is emitted as `typeof(List)` and fails compile with
// GS0113 "Type 'List' doesn't exist" (and GS0158 on `.Name`).
using System;
using System.Collections.Generic;

namespace Corpus.Grid08
{
    public static class OmittedTypeArgumentFixture
    {
        public static void Run()
        {
            Console.WriteLine("OmittedTypeArgument: nameof=" + nameof(List<>));
            Console.WriteLine("OmittedTypeArgument: nameof-two-arity=" + nameof(Dictionary<,>));
        }
    }
}
