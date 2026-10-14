// inventory: OmittedTypeArgument — nameof/typeof of an unbound generic (C#14 probe)
// issue #1915 (fixed): typeof of an unbound generic (`typeof(List<>)`,
// `typeof(Dictionary<,>)`) translates to G#'s explicit-arity `_` placeholder
// form (`typeof(List[_])`, `typeof(Dictionary[_, _])` — G# has no
// `Name<>`/`Name<,>` comma-count spelling; issue #2012 (S1) wires cs2gs to
// emit the canonical arity-suffixed form established by #1989/#2011).

package Corpus.Grid08

import System
import System.Collections.Generic

shared class OmittedTypeArgumentFixture {
    func Run() {
        Console.WriteLine("OmittedTypeArgument: nameof=" + "List")
        Console.WriteLine("OmittedTypeArgument: nameof-two-arity=" + "Dictionary")
        Console.WriteLine("OmittedTypeArgument: typeof=" + typeof(List[_]).Name)
        Console.WriteLine("OmittedTypeArgument: typeof-two-arity=" + typeof(Dictionary[_, _]).Name)
    }
}
