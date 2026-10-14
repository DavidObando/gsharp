// <copyright file="RandomizedDriverConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.LanguageConformance

import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

open class RandomizedDriverConformanceTests {
    @Theory
    @MemberData("Seeds")
    async func GeneratedProgram_ConformsAcrossAllDrivers(seed int32) {
        let source = GenerateProgram(seed)
        let testDirectory string? = Path.GetDirectoryName(typeof(RandomizedDriverConformanceTests).Assembly.Location)
        Assert.NotNull(testDirectory)
        let sourceDirectory = Path.Combine(
            testDirectory!!,
            "randomized-driver-conformance",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(sourceDirectory)
        let sourcePath = Path.Combine(sourceDirectory, "Seed${seed:D2}.gs")
        File.WriteAllText(sourcePath, source)
        try {
            let exception Exception? = await Record.ExceptionAsync(
                () -> DriverConformanceHarness.AssertSingleFileConformsAsync("RandomizedSeed${seed:D2}", sourcePath)
            )
            Assert.True(exception == nil, (`Randomized conformance seed ` + "$seed" + ` failed.

` + "$source" + `

` + "$exception"))
        } finally {
            Directory.Delete(sourceDirectory, recursive: true)
        }
    }

    @Fact
    func GeneratedPrograms_AreDeterministicAndDiverse() {
        let programs = Enumerable.Range(0, CaseCount).Select(GenerateProgram).ToArray()
        Assert.Equal(programs, Enumerable.Range(0, CaseCount).Select(GenerateProgram))
        Assert.Equal(CaseCount, programs.Distinct(StringComparer.Ordinal).Count())
        Assert.All(
            programs,
            (program string) -> {
                Assert.Contains("if ", program, StringComparison.Ordinal)
                Assert.Contains("while ", program, StringComparison.Ordinal)
            }
        )
    }

    shared {
        internal const CaseCount int32 = 32
        func Seeds() IEnumerable[[]object] -> Enumerable.Range(0, CaseCount).Select((seed int32) -> []object{seed})

        private func GenerateProgram(seed int32) string {
            let random = Random(seed)
            let initial = GenerateExpression(random, depth: 3, "a", "b", "c")
            let whenTrue = GenerateExpression(random, depth: 2, "value", "a", "b", "c")
            let whenFalse = GenerateExpression(random, depth: 2, "value", "a", "b", "c")
            let condition = GenerateCondition(random, "a", "b", "c")
            let steps = random.Next(1, 7)
            let mask = random.Next(1, 64)
            return (`package RandomizedConformance.Seed` + "${seed:D2}" + `
import System

var a = ` + "${random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)}" + `
var b = ` + "${random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)}" + `
var c = ` + "${random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)}" + `
var value = ` + "$initial" + `
if ` + "$condition" + ` {
    value = ` + "$whenTrue" + `
} else {
    value = ` + "$whenFalse" + `
}
var index = 0
while index < ` + "${steps.ToString(CultureInfo.InvariantCulture)}" + ` {
    value = (value + index) ^ ` + "${mask.ToString(CultureInfo.InvariantCulture)}" + `
    index++
}
Console.WriteLine(` + "${seed.ToString(CultureInfo.InvariantCulture)}" + `)
Console.WriteLine(value)
Console.WriteLine((value & 1) == 0)
`)
        }

        private func GenerateExpression(random Random, depth int32, variables ...string) string {
            if depth == 0 || random.Next(4) == 0 {
                return if random.Next(3) == 0 {
                    random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)
                } else {
                    variables[random.Next(variables.Length)]
                }
            }
            let left = GenerateExpression(random, depth - 1, variables)
            if random.Next(5) == 0 {
                return "($left % ${random.Next(1, 17).ToString(CultureInfo.InvariantCulture)})"
            }
            let right = GenerateExpression(random, depth - 1, variables)
            let operation = []string{"+", "-", "*", "^", "&", "|"} [random.Next(6)]
            return "($left $operation $right)"
        }

        private func GenerateCondition(random Random, variables ...string) string {
            let left = GenerateExpression(random, depth: 1, variables)
            let right = GenerateExpression(random, depth: 1, variables)
            let otherLeft = GenerateExpression(random, depth: 1, variables)
            let otherRight = GenerateExpression(random, depth: 1, variables)
            let comparison = []string{"<", "<=", "==", "!=", ">=", ">"} [random.Next(6)]
            let otherComparison = []string{"<", "<=", "==", "!=", ">=", ">"} [random.Next(6)]
            let junction = if random.Next(2) == 0 {
                "&&"
            } else {
                "||"
            }
            return "(($left $comparison $right) $junction ($otherLeft $otherComparison $otherRight))"
        }
    }
}
