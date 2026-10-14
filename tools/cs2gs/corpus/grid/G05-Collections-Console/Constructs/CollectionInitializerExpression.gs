// inventory: CollectionInitializerExpression

package Corpus.Grid05

import System
import System.Collections.Generic

shared class CollectionInitializerExpressionFixture {
    func Run() {
        let list = List[int32]{1, 2, 3}
        Console.WriteLine("CollectionInitializerExpression: list=${string.Join(",", list)}")
        // ComplexElementInitializerExpression: { key, value } pairs.
        let pairs = Dictionary[string, int32]{"apple": 3, "kiwi": 1, "pear": 2}
        PrintOrdered("pairs", pairs)
        // ImplicitElementAccess: the ["key"] = value dictionary-initializer
        // form (issue #1897 — was CS2GS-GAP; already had a canonical G#
        // form via the existing indexed CollectionInitializerElement path,
        // this fixture just re-enables the corpus coverage for it).
        let indexed = Dictionary[string, int32]{["blue"] = 2, ["red"] = 5, ["green"] = 4}
        PrintOrdered("indexed", indexed)
    }

    private func PrintOrdered(label string, $map Dictionary[string, int32]) {
        let keys = List[string]($map.Keys)
        keys.Sort(StringComparer.Ordinal)
        let parts = List[string]()
        for key in keys {
            parts.Add("$key=${$map[key]}")
        }
        Console.WriteLine("CollectionInitializerExpression: $label ${string.Join(";", parts)}")
    }
}
