from .server import main

# Guarded: OCR worker processes (multiprocessing "spawn") import the main module again.
if __name__ == "__main__":
    main()
