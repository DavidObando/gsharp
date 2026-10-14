// <copyright file="Issue3093SequenceInterfaceBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

class Issue3093SequenceInterfaceBindingTests {
    @Fact
    func GenericIteratorAndExplicitSequence_SatisfyIEnumerableContracts() {
        const Source = `import System.Collections.Generic

func One[T](value T) sequence[T] {
    yield value
}

interface IDetector {
    func Iterate[T](value T) IEnumerable[T];
    func Explicit[T](value T) IEnumerable[T];
}

class Detector : IDetector {
    func Iterate[T](value T) sequence[T] {
        yield value
    }

    func Explicit[T](value T) sequence[T] {
        return One(value)
    }
}`
        Assert.Empty(Evaluate(Source).Diagnostics)
    }

    @Fact
    func GenericTypeSequence_SatisfiesConstructedInterfaceContract() {
        const Source = `import System.Collections.Generic

interface IDetector[T] {
    func Detect(value T) IEnumerable[T];
}

class Detector[T] : IDetector[T] {
    func Detect(value T) sequence[T] {
        yield value
    }
}`
        Assert.Empty(Evaluate(Source).Diagnostics)
    }

    @Fact
    func SequenceAndIEnumerable_AreIdentityCompatibleForOpenTypeParameter() {
        const Source = `import System.Collections.Generic

func Adapt[T](values sequence[T]) IEnumerable[T] {
    return values
}`
        Assert.Empty(Evaluate(Source).Diagnostics)
    }

    @Fact
    func AsyncSequence_SatisfiesIAsyncEnumerableContract() {
        const Source = `import System.Collections.Generic
import System.Threading.Tasks

interface IDetector {
    func Detect[T](value T) IAsyncEnumerable[T];
}

class Detector : IDetector {
    async func Detect[T](value T) sequence[T] {
        await Task.Yield()
        yield value
    }
}`
        Assert.Empty(Evaluate(Source).Diagnostics)
    }

    @Theory
    @InlineData("IEnumerable[T]", "async func")
    @InlineData("IAsyncEnumerable[T]", "func")
    func SyncAndAsyncSequenceContracts_RemainDistinct(contractType string, implementationModifier string) {
        let source = (`import System.Collections.Generic

interface IDetector {
    func Detect[T](value T) ` + "$contractType" + `;
}

class Detector : IDetector {
    ` + "$implementationModifier" + ` Detect[T](value T) sequence[T] {
        yield value
    }
}`)
        Assert.Contains(Evaluate(source).Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0187")
    }

    @Fact
    func CovariantElementConversion_DoesNotChangeInterfaceSignatureIdentity() {
        const Source = `import System.Collections.Generic

interface IStrings {
    func Values() IEnumerable[object];
}

class Strings : IStrings {
    func Values() sequence[string] {
        yield "value"
    }
}`
        Assert.Contains(Evaluate(Source).Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0187")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
