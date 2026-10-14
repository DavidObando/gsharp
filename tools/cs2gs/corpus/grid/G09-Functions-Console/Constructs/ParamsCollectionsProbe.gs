// inventory: Parameter — C#13 params collections (params List&lt;int&gt;,
// params IEnumerable&lt;string&gt;). Issue #1901: gsc's own variadic parameter
// is always an array/slice, so these are declared as ordinary parameters of
// the full collection type; an expanded call site (`Total(1, 2, 3)`,
// including the zero-arg `Total()` form) is lowered into an explicit
// collection construction (`List[int32]{1, 2, 3}` / `List[int32]()`).

package Corpus.Grid09

import System
import System.Collections.Generic

shared class ParamsCollectionsProbeFixture {
    func Run() {
        // C#13 params collections probe: params List<int> / IEnumerable<string>.
        Console.WriteLine("ParamsCollectionsProbe: totalNone=${Total()}")
        Console.WriteLine("ParamsCollectionsProbe: totalThree=${Total(1, 2, 3)}")
        Console.WriteLine("ParamsCollectionsProbe: joined=${JoinParts("a", "b", "c")}")
    }

    private func Total(values ...List[int32]) int32 {
        var total = 0
        for v in values {
            total += v
        }
        return total
    }

    private func JoinParts(parts ...IEnumerable[string]) string {
        return string.Join("+", parts)
    }
}
