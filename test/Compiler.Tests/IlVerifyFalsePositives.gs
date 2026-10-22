package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Collections.Generic
import System.Globalization
import System.Text.RegularExpressions

/// Shared fail-closed adapter for the test helper and standalone ILVerify gate.
internal shared class IlVerifyFalsePositives {
    func OnlyKnown(assemblyPath string, stdout string) bool {
        let errorLines = List[string]()
        var reportedCount int32? = nil
        for rawLine in stdout.Replace("\r\n", "\n").Split('\n') {
            let line = rawLine.Trim()
            if line.StartsWith("[IL]: Error", StringComparison.Ordinal) {
                errorLines.Add(line)
                continue
            }
            let summary = Regex.Match(line, "^(\\d+) Error\\(s\\) Verifying ")
            if summary.Success {
                if reportedCount != nil {
                    return false
                }
                reportedCount = int32.Parse(summary.Groups[1].Value, CultureInfo.InvariantCulture)
            } else if line.Length != 0 {
                return false
            }
        }
        if errorLines.Count == 0 || reportedCount != errorLines.Count {
            return false
        }
        let filterRule = IlVerifyFilterInFinallyRule.Load(assemblyPath)
        for line in errorLines {
            if !filterRule.Matches(errorCode: nil, line) && !IlVerifyStaticInterfaceRule.Matches(assemblyPath, line) {
                return false
            }
        }
        return true
    }
}
