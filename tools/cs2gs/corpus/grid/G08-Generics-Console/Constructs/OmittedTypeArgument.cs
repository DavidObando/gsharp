// inventory: OmittedTypeArgument — nameof/typeof of an unbound generic (C#14 probe)
// issue #1915 (fixed): typeof of an unbound generic (`typeof(List<>)`,
// `typeof(Dictionary<,>)`) translates to G#'s explicit-arity `_` placeholder
// form (`typeof(List[_])`, `typeof(Dictionary[_, _])` — G# has no
// `Name<>`/`Name<,>` comma-count spelling; issue #2012 (S1) wires cs2gs to
// emit the canonical arity-suffixed form established by #1989/#2011).
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

