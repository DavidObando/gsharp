// <copyright file="Issue5797StaticInitializerConstLocalTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Tests
import Xunit

/// Issue #5797: a `const` local has no IL slot, so the emitter inlines each read of it. The type
/// initializer of a class or struct without an initialization plan did not record the `const`
/// bindings of its static `init` statements. A member access on the local, an interpolation of it, or
/// (before #5800 gave such blocks a plan) a function literal that captured it failed with GS9998 "has no
/// local slot or parameter index in the current method".
open class Issue5797StaticInitializerConstLocalTests {
    /// A static `init` block without a function literal has no initialization plan. Each row failed with
    /// GS9998 before the correction.
    @Theory
    @InlineData(
        "class K {\n    shared {\n        var S string = \"\"\n        init {\n            const d int32 = 300\n            const e string = \"x\"\n            S = d.ToString() + e.ToUpper()\n        }\n    }\n}\nK.S",
        "300X"
    )
    @InlineData(
        "class K {\n    shared {\n        var S string = \"\"\n        init {\n            const d int32 = 300\n            S = \"$${d}\"\n        }\n    }\n}\nK.S",
        "300"
    )
    @InlineData(
        "class K {\n    shared {\n        var S int32 = 0\n        init {\n            const e string = \"xyz\"\n            S = e.Length\n        }\n    }\n}\nK.S",
        "3"
    )
    @InlineData(
        "struct P {\n    var X int32\n    shared {\n        var S bool = false\n        init {\n            const d int32 = 300\n            S = d.Equals(300)\n        }\n    }\n}\nP.S",
        "True"
    )
    func ConstLocalInUnplannedStaticInitBlock_EmitsItsValue(source string, expected string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// A function literal that captures a `const` local of a static `init` block. These rows failed with
    /// GS9998 on 14798db38. Since #5800 the block has an initialization plan, so they guard that path.
    @Theory
    @InlineData(
        "class K {\n    shared {\n        var S int32 = 0\n        init {\n            const d int32 = 300\n            let g = () -> d + 1\n            S = g()\n        }\n    }\n}\nK.S",
        "301"
    )
    @InlineData(
        "class K {\n    shared {\n        var S string = \"\"\n        init {\n            const d string = \"cs\"\n            let g = () -> d + \"!\"\n            S = g()\n        }\n    }\n}\nK.S",
        "cs!"
    )
    @InlineData(
        "class K {\n    shared {\n        var S float64 = 0.0\n        init {\n            const d float64 = 2.5\n            let g = () -> {\n                let h = () -> d * 2.0\n                return h()\n            }\n            S = g()\n        }\n    }\n}\nK.S",
        "5"
    )
    @InlineData(
        "class K {\n    shared {\n        var S string = \"\"\n        init {\n            const c char = 'z'\n            const b bool = true\n            let g = () -> if b {\n                c\n            } else {\n                'a'\n            }\n            S = g().ToString()\n        }\n    }\n}\nK.S",
        "z"
    )
    @InlineData(
        "struct P {\n    var X int32\n    shared {\n        var S int64 = 0\n        init {\n            const d int64 = 9000000000\n            let g = () -> d + 1\n            S = g()\n        }\n    }\n}\nP.S",
        "9000000001"
    )
    @InlineData(
        "class K[T] {\n    shared {\n        var S string = \"\"\n        init {\n            const d int32 = 7\n            let g = () -> d.ToString() + typeof(T).Name\n            S = g()\n        }\n    }\n}\nK[int32].S",
        "7Int32"
    )
    @InlineData(
        "class K {\n    shared {\n        var S int32 = 0\n        init {\n            const d int32 = 1\n            let g = () -> d\n            S = g()\n        }\n        init {\n            const d int32 = 2\n            let g = () -> d\n            S = S * 10 + g()\n        }\n    }\n}\nK.S",
        "12"
    )
    func CapturedConstLocalInStaticInitBlock_EmitsItsValue(source string, expected string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// Regression guards: these positions already recorded `const` bindings, or a captured non-`const`
    /// local has a slot. They pass with and without the correction.
    @Theory
    @InlineData(
        "class K {\n    shared {\n        var S int32 = 0\n        init {\n            let d int32 = 300\n            let g = () -> d + 1\n            S = g()\n        }\n    }\n}\nK.S",
        "301"
    )
    @InlineData(
        "class K {\n    shared {\n        var F int32 = (() -> {\n            const d int32 = 7\n            let h = () -> d * 2\n            return h()\n        })()\n    }\n}\nK.F",
        "14"
    )
    @InlineData(
        "class K {\n    var F int32 = (() -> {\n        const d int32 = 11\n        let h = () -> d + 1\n        return h()\n    })()\n}\nK().F",
        "12"
    )
    @InlineData(
        "open class B {\n    let V int32\n    init(v int32) {\n        V = v\n    }\n}\nclass K : B {\n    init() : base((() -> {\n        const d int32 = 41\n        let h = () -> d + 1\n        return h()\n    })()) { }\n}\nK().V",
        "42"
    )
    @InlineData(
        "class K {\n    var V int32\n    init() {\n        const d int32 = 9\n        let g = () -> d\n        V = g()\n    }\n}\nK().V",
        "9"
    )
    @InlineData(
        "func F() int32 {\n    var total int32 = 0\n    for var i int32 = 0; i < 3; i++ {\n        const d int32 = 5\n        let g = () -> d + i\n        total += g()\n    }\n    return total\n}\nF()",
        "18"
    )
    @InlineData(
        "class K {\n    var V int32\n    init() {\n        var x int32 = 1\n        let inc = () -> {\n            x = x + 10\n        }\n        inc()\n        inc()\n        V = x\n    }\n}\nK().V",
        "21"
    )
    func ConstOrCapturedLocalInOtherPositions_EmitsItsValue(source string, expected string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }
}
