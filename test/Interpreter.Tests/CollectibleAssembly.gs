// <copyright file="CollectibleAssembly.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import System
import System.IO
import System.Reflection
import System.Runtime.Loader

internal shared class CollectibleAssembly {
    func Inspect(assemblyPath string, inspect(Assembly) -> void) -> Inspect(
        assemblyPath,
        (assembly Assembly) -> {
            inspect(assembly)
            return true
        }
    )

    func Inspect[T](assemblyPath string, inspect(Assembly) -> T) T {
        let directory = Path.GetDirectoryName(assemblyPath)!!
        let loadContext = AssemblyLoadContext(
            "gsharp-test-inspection-" + Guid.NewGuid().ToString("N"),
            isCollectible: true
        )
        loadContext.Resolving += (context AssemblyLoadContext, name AssemblyName) -> {
            let localPath = Path.Combine(directory, name.Name + ".dll")
            if File.Exists(localPath) {
                using let dependency = File.OpenRead(localPath)
                return context.LoadFromStream(dependency)
            }
            try {
                return Assembly.Load(name)
            } catch (ex Exception) when ex is FileNotFoundException ||
                ex is FileLoadException ||
                ex is BadImageFormatException {
                return nil
            }
        }
        try {
            using let stream = File.OpenRead(assemblyPath)
            return inspect(loadContext.LoadFromStream(stream))
        } finally {
            loadContext.Unload()
        }
    }
}
