// <copyright file="BaseClassCycleUnsafeWalkAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers.Tests

import GSharp.InternalAnalyzers
import System.Threading.Tasks
import Xunit

class BaseClassCycleUnsafeWalkAnalyzerTests {
    @Fact
    func ReportsForLoopWalk() Task {
        const Source = `internal class StructSymbol {
    var BaseClass StructSymbol?
}

internal class Walker {
    private func Walk(s StructSymbol) {
        for var c StructSymbol? = s.BaseClass; c != nil; [|c = c!!.BaseClass|] {
        }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006")
    }

    @Fact
    func ReportsWhileLoopWalk() Task {
        const Source = `internal class StructSymbol {
    var BaseClass StructSymbol?
}

internal class Walker {
    private func Walk(s StructSymbol) {
        var current StructSymbol? = s
        while current != nil {
            [|current = current!!.BaseClass|]
        }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006")
    }

    @Fact
    func ReportsDoWhileLoopWalk() Task {
        const Source = `internal class StructSymbol {
    var BaseClass StructSymbol?
}

internal class Walker {
    private func Walk(s StructSymbol) {
        var current StructSymbol? = s
        do {
            [|current = current!!.BaseClass|]
        } while current != nil
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source, "GSA0006")
    }

    @Fact
    func IgnoresGetHierarchyItself() Task {
        // The one sanctioned implementation every other walk should call
        // instead: StructSymbol.GetHierarchy() is exempt so this rule does
        // not flag its own guarded (or, as here, simplified) walk.
        const Source = `import System.Collections.Generic

internal class StructSymbol {
    var BaseClass StructSymbol?

    private func GetHierarchy() List[StructSymbol] {
        let hierarchy = List[StructSymbol]()
        var current StructSymbol? = this
        while current != nil {
            hierarchy.Add(current!!)
            current = current.BaseClass
        }
        return hierarchy
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source)
    }

    @Fact
    func IgnoresDetectClassInheritanceCyclesItself() Task {
        // DeclarationBinder.DetectClassInheritanceCycles() is the post-bind
        // cycle detector (#973) itself: it cannot call GetHierarchy() because
        // it needs the exact back-edge node to break, not just an acyclic
        // prefix. Its own onPath/acyclic-set guard is exempt.
        const Source = `internal class StructSymbol {
    var BaseClass StructSymbol?
}

internal class DeclarationBinder {
    private func DetectClassInheritanceCycles(start StructSymbol) {
        var current StructSymbol? = start
        while current != nil {
            current = current.BaseClass
        }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source)
    }

    @Fact
    func IgnoresSingleHopFetchIntoNewVariable() Task {
        // Fetching the immediate base class into a NEW variable name is the
        // ordinary, safe, single-hop shape used throughout the binder (e.g.
        // `if (x.BaseClass != null)`); it is not a walk and is not flagged.
        const Source = `internal class StructSymbol {
    var BaseClass StructSymbol?
}

internal class Checker {
    private func HasBase(s StructSymbol) bool {
        let parent StructSymbol? = s.BaseClass
        return parent != nil
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source)
    }

    @Fact
    func IgnoresUnrelatedTypeNamedSimilarly() Task {
        // A `.BaseClass` self-reassignment loop on a type that is not named
        // `StructSymbol` is not this bug class; the semantic containing-type
        // check keeps the rule scoped to the actual symbol hierarchy.
        const Source = `internal class SomeOtherType {
    var BaseClass SomeOtherType?
}

internal class Walker {
    private func Walk(s SomeOtherType) {
        var current SomeOtherType? = s
        while current != nil {
            current = current!!.BaseClass
        }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source)
    }

    @Fact
    func IgnoresGuardedWalkThroughHierarchyHelper() Task {
        // The consolidated, GetHierarchy()-based pattern every #4164 fix
        // landed on: no direct `.BaseClass` self-reassignment loop remains,
        // so nothing to flag.
        const Source = `import System.Collections.Generic

internal class StructSymbol {
    var BaseClass StructSymbol?

    func GetHierarchy() List[StructSymbol] {
        let hierarchy = List[StructSymbol]()
        var current StructSymbol? = this
        while current != nil {
            hierarchy.Add(current!!)
            current = current.BaseClass
        }
        return hierarchy
    }
}

internal class Walker {
    private func FindAncestor(container StructSymbol, target StructSymbol) bool {
        let chain = container.GetHierarchy()
        for var i = 1; i < chain.Count; i++ {
            if chain[i] == target {
                return true
            }
        }
        return false
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(BaseClassCycleUnsafeWalkAnalyzer(), Source)
    }
}
