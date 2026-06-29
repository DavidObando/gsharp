package Oahu.Decrypt.Mpeg4.Util

import System
import System.Security.Cryptography

unsafe class AesCtr : IDisposable {
    private let encryptor ICryptoTransform
    private let aes Aes
    private let encryptedCounter []uint8 = [AesCtr.AesBlockSize]uint8
    private var isDisposed bool

    init(key []uint8) {
        ArgumentNullException.ThrowIfNull(key, nameof(key))
        if key.Length != AesCtr.AesBlockSize {
            throw ArgumentException("${nameof(key)} must be exactly ${AesCtr.AesBlockSize} bytes long.")
        }
        aes = Aes.Create()
        this.aes.Padding = PaddingMode.None
        this.aes.Mode = CipherMode.ECB
        encryptor = aes.CreateEncryptor(key, nil)
    }

    func Decrypt(iv []uint8, source ReadOnlySpan[uint8], destination Span[uint8]) {
        ArgumentNullException.ThrowIfNull(iv, nameof(iv))
        ArgumentOutOfRangeException.ThrowIfNotEqual(iv.Length, AesCtr.AesBlockSize, nameof(iv))
        if destination.Length < source.Length {
            throw ArithmeticException("Destination array is not long enough. (Parameter '${nameof(destination)}')")
        }
        const aesNumDwords = AesCtr.AesBlockSize / 4
        fixed pD *uint8 = destination {
            fixed pS *uint8 = source {
                fixed pEc *uint8 = encryptedCounter {
                    var pD32 = *uint32(pD)
                    var pS32 = *uint32(pS)
                    let pEc32 = *uint32(pEc)
                    var dataPos = 0
                    var count = source.Length
                    while count >= AesCtr.AesBlockSize {
                        encryptor.TransformBlock(iv, 0, AesCtr.AesBlockSize, encryptedCounter, 0)
                        AesCtr.IncrementBE(iv)
                        for var i = 0; i < aesNumDwords; i++ {
                            *pD32 = pEc32[i] ^ *pS32
                            pD32++
                            pS32++
                        }
                        dataPos += AesCtr.AesBlockSize
                        count -= AesCtr.AesBlockSize
                    }
                    if count > 0 {
                        encryptor.TransformBlock(iv, 0, AesCtr.AesBlockSize, encryptedCounter, 0)
                        {
                            var i = 0
                            while i < count {
                                pD[dataPos] = uint8((pEc[i] ^ pS[dataPos]))
                                i++
                                dataPos++
                            }
                        }
                    }
                }
            }
        }
    }

    func Dispose() {
        Dispose(true)
        GC.SuppressFinalize(this)
    }

    private func Dispose(disposing bool) {
        if disposing & !isDisposed {
            encryptor.Dispose()
            aes.Dispose()
            isDisposed = true
        }
    }

    shared {
        const AesBlockSize int32 = 16

        private func IncrementBE(data []uint8) {
            var i = data.Length - 1
            do {
                data[i]++
            } while data[i] == uint8(0) && i-- > 0
        }
    }
}
