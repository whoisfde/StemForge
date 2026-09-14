import multiprocessing
from app.main import app as fastapi_app
import uvicorn

if __name__ == "__main__":
    multiprocessing.freeze_support()
    uvicorn.run(fastapi_app, host="127.0.0.1", port=17890)
