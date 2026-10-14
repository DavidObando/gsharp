// <copyright file="Issue2920ReleaseJitOptimizerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import Xunit

open class Issue2920ReleaseJitOptimizerTests {
    @Theory
    @InlineData(nil, "/debug:portable", true, int32(2))
    @InlineData("/optimize+", "/debug:portable", true, int32(2))
    @InlineData("/optimize-", "/debug:portable", true, int32(257))
    @InlineData("/optimize-", "/debug-", false, int32(257))
    func Main_OptimizeFlag_ControlsJitFlagsIndependentlyFromPdb(
        optimizeFlag string?,
        debugFlag string,
        expectPdb bool,
        expectedFlags int32
    ) {
        let id = Guid.NewGuid().ToString("N")
        let directory = Path.Combine(Directory.GetCurrentDirectory(), ".issue2920-" + id)
        Assert.False(Directory.Exists(directory))
        Directory.CreateDirectory(directory)
        let sourcePath = Path.Combine(directory, "program.gs")
        let outputPath = Path.Combine(directory, "Issue2920" + id + ".dll")
        let pdbPath = Path.ChangeExtension(outputPath, ".pdb")
        File.WriteAllText(sourcePath, (`package Issue2920` + "$id" + `

func Value() int {
    return 11
}
`))
        try {
            let arguments = []string? {"/out:" + outputPath, "/target:library", debugFlag, optimizeFlag, sourcePath}
                .Where((argument string) -> argument != nil).ToArray()
            let exit = Program.Main(arguments)
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outputPath))
            Assert.Equal(expectPdb, File.Exists(pdbPath))
            IlVerifier.Verify(outputPath)
            let assembly = EmittedFixture.Load(outputPath)
            Assert.NotEmpty(assembly.GetTypes())
            let debuggable DebuggableAttribute? = assembly.GetCustomAttribute[DebuggableAttribute]()
            Assert.NotNull(debuggable)
            Assert.Equal(DebuggableAttribute.DebuggingModes(expectedFlags), debuggable!!.DebuggingFlags)
            if expectPdb {
                using let pdbStream = File.OpenRead(pdbPath)
                using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
                let reader = provider.GetMetadataReader()
                Assert.NotEmpty(reader.Documents)
                Assert.Contains(
                    reader.MethodDebugInformation,
                    (handle MethodDebugInformationHandle) -> reader
                        .GetMethodDebugInformation(handle)
                        .GetSequencePoints()
                        .Any()
                )
            }
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
