// inventory: OmittedTypeArgument — nameof/typeof of an unbound generic (C#14 probe)
// issue #1915 (fixed): typeof of an unbound generic (`typeof(List<>)`,
// `typeof(Dictionary<,>)`) translates to the bare generic-definition name
// (`typeof(List)`, `typeof(Dictionary)` — G# has no open-generic `typeof`
// spelling); gsc's binder now resolves that bare imported-generic name to the
// CLR open generic type definition via an arity-suffixed reflection lookup.
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
            Console.WriteLine("OmittedTypeArgument: typeof=" + typeof(List<>).Name);
            Console.WriteLine("OmittedTypeArgument: typeof-two-arity=" + typeof(Dictionary<,>).Name);
        }
    }
}

