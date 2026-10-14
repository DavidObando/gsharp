// <copyright file="Issue2535NullableReferenceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #2535: class-to-interface conversion must honor the same safe
/// declaration-site variance as an already interface-typed value.
class Issue2535NullableReferenceConversionTests {
    @Fact
    func CovariantImplementedInterfaceLiftsThroughReferenceNullability() {
        // ADR-0156 Phase 3c (#3176): unpinned onto the emitted oracle — the
        // #3241 emitter fix lowers the covariant interface lift through
        // reference nullability (issue #3236).
        let result = Evaluate(`interface IService[out T] {}
class Service : IService[object] {}

func InterfaceControl(value IService[object]) IService[object?]? -> value
func Lift(value Service) IService[object?]? -> value
func NullableLift(value Service?) IService[object?]? -> value
func AssertedLift(value Service?) IService[object?] -> value!!
func FlowLift(value object?) IService[object?]? {
    if value is Service {
        return value
    }
    return nil
}`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableReferenceCannotFlowToNonNullableOrUnrelatedTarget() {
        let result = Evaluate(`interface IService {}
class Service : IService {}
class Other {}
interface IInvariant[T] {}
class InvariantService : IInvariant[object] {}

func DropsNull(value Service?) IService -> value
func Unrelated(value Other) IService? -> value
func InvariantWiden(value InvariantService) IInvariant[object?]? -> value`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> (d.Id is "GS0155" or "GS0156"))
        Assert.Equal(3, result.Diagnostics.Count())
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}
