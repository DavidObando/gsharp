// <copyright file="ArrayValueFeasibilityTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection
import System.Security.Cryptography
import Xunit
import Xunit.Abstractions

/// ADR-0210 research fixtures, not G# fixed-array lowering or SDK types.
open class ArrayValueFeasibilityTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData("Encoding", "encoding:33 lengths; open/reference/nested copies; invalid imports rejected")
    @InlineData("Locations", "locations:escaped GC; live field/swap/recursive array paths; permissions and bounds")
    func Prototype_EncodingAndRetainedLocations(method string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtime = fixture.CompileCSharp(Read("Storage") + "\n" + Read("Locations"), "ArrayValueResearch")
        let scenarios = fixture.CompileCSharp(Read("Scenarios"), "ArrayValueScenarios", runtime)
        this.LogProducts(runtime, scenarios)
        VerifyRuntime(runtime)
        // Scenario IL has additional Roslyn byref/readonly verifier failures; retain JIT evidence only.
        let assemblies = EmittedFixture.LoadTogether(runtime, scenarios)
        Assert.Equal(expected, Invoke(assemblies[1], "Scenarios", method))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Prototype_IndependentLibrariesExchangeCanonicalValues(referenceAssemblies bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReference = Path.Combine(fixture.Directory, "ArrayValueResearch.ref.dll")
        let runtime = fixture.CompileCSharpWithReference(
            Read("Storage") + "\n" + Read("Locations"),
            "ArrayValueResearch",
            runtimeReference
        )
        let scenarios = fixture.CompileCSharp(Read("Scenarios"), "ArrayValueScenarios", runtime)
        let generator = EmittedFixture.LoadTogether(runtime, scenarios)[1]
        let contract = if referenceAssemblies {
            runtimeReference
        } else {
            runtime
        }
        let producerReference = Path.Combine(fixture.Directory, "Producer.ref.dll")
        let producer = fixture.CompileCSharpWithReference(
            cast[string](Invoke(generator, "Scenarios", "Library", []object{"Producer"})),
            "Producer",
            producerReference,
            contract
        )
        let consumerReference = Path.Combine(fixture.Directory, "Consumer.ref.dll")
        let consumer = fixture.CompileCSharpWithReference(
            cast[string](Invoke(generator, "Scenarios", "Library", []object{"Consumer"})),
            "Consumer",
            consumerReference,
            contract
        )
        let client = fixture.CompileCSharp(
            cast[string](Invoke(generator, "Scenarios", "Client")),
            "Client",
            contract,
            if referenceAssemblies {
                producerReference
            } else {
                producer
            },
            if referenceAssemblies {
                consumerReference
            } else {
                consumer
            }
        )
        this.LogProducts(runtime, runtimeReference, producer, producerReference, consumer, consumerReference, client)
        VerifyRuntime(runtime)
        // ILVerify 10.0.8 rejects generic-struct ref returns and static-interface dispatch.
        for library in[]string{producer, consumer} {
            IlVerifier.Verify(
                library,
                []string{runtime},
                []string{"ReturnPtrToStack", "CallAbstract", "Constrained"},
                "(Producer|Consumer)\\.(Ref|Build|Accept)$$"
            )
        }
        IlVerifier.Verify(client, []string{runtime, producer, consumer})
        let assemblies = EmittedFixture.LoadTogether(runtime, producer, consumer, client)
        Assert.Equal(
            "exchange:33 invariant lists; open/reference/nested/ref signatures; no adapters",
            Invoke(assemblies[3], "Client", "Run")
        )
    }

    private func LogProducts(paths ...string) {
        for path in paths {
            this.output.WriteLine(
                Path.GetFileName(path) + " sha256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
            )
        }
    }

    shared {
        private func VerifyRuntime(runtime string) {
            // Static-interface dispatch has a known verifier limit; see IlVerifier.KnownIssues.
            IlVerifier.Verify(
                runtime,
                ignoredErrorCodes: []string{"ReturnPtrToStack", "CallAbstract", "Constrained"},
                ignoredErrorScope: "(Leaf`1\\.At|Branch`3\\.|ReadView|WriteView)"
            )
        }

        private func Read(name string) string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                if RepositoryRootMarker.IsRoot(directory.FullName) {
                    return File.ReadAllText(
                        Path.Combine(
                            directory.FullName,
                            "test",
                            "Compiler.Tests",
                            "Fixtures",
                            "ArrayValueFeasibility",
                            name + ".cs.txt"
                        )
                    )
                }
                directory = directory.Parent
            }
            throw InvalidOperationException("Could not locate repository root.")
        }

        private func Invoke(assembly Assembly, type string, method string, arguments[]object? = nil) object? {
            try {
                return assembly.GetType(type, throwOnError: true)!!.GetMethod(method)!!.Invoke(nil, arguments)
            } catch (ex TargetInvocationException) {
                throw ex.InnerException ?? ex
            }
        }
    }
}
